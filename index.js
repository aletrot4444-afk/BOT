import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { createClient } from '@supabase/supabase-js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
  ]
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CANAL_REGISTRO_ID = process.env.CANAL_REGISTRO_ID;
const registrosPendientes = new Map(); // discord_id -> datos del formulario

client.once('ready', () => {
  console.log(`✅ Bot conectado como ${client.user.tag}`);
});

// Paso 1: Escuchar el formulario en el canal de registro
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== CANAL_REGISTRO_ID) return;

  const texto = message.content;

  // Acepta tanto "Gmail:" como "Correo:" para el campo de correo
  const nick = texto.match(/Nick:\s*(.+)/i)?.[1]?.trim();
  const rango = texto.match(/Rango:\s*(.+)/i)?.[1]?.trim();
  const gmail = texto.match(/(?:Gmail|Correo):\s*(.+)/i)?.[1]?.trim();
  const quienTeMetio = texto.match(/Quien te metio\??:\s*(.+)/i)?.[1]?.trim();

  // Si el mensaje no tiene ninguno de los campos, no es un intento de registro; lo ignoramos
  if (!nick && !rango && !gmail && !quienTeMetio) return;

  // Si tiene algunos campos pero faltan otros, avisamos qué falta
  if (!nick || !rango || !gmail || !quienTeMetio) {
    return message.reply(
      '❌ Formato incompleto. Asegúrate de incluir Nick, Rango, Correo y Quien te metio, cada uno en su propia línea.'
    );
  }

  // Validación básica del correo
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(gmail)) {
    return message.reply('❌ El correo no parece válido. Intenta de nuevo.');
  }

  // Guardamos los datos temporalmente mientras esperamos la contraseña por DM
  registrosPendientes.set(message.author.id, { nick, rango, gmail, quienTeMetio });

  try {
    const dm = await message.author.createDM();
    const embed = new EmbedBuilder()
      .setTitle('🔐 Configura tu acceso a la guía')
      .setDescription(
        `Para completar tu registro, responde este mensaje con la contraseña que quieres usar para entrar a la página de la guía.\n\n` +
        `Correo registrado: **${gmail}**\n\n` +
        `⚠️ Usa una contraseña que no uses en otro lado (no tu contraseña de Gmail real).\n` +
        `Debe tener al menos 8 caracteres.\n
        En caso de que compartas la contraseña seras blacklisteado PERMANENTEMENTE`
      )
      .setColor(0x00AE86);

    await dm.send({ embeds: [embed] });
    await message.reply('✅ Te mandé un DM para que termines tu registro.');
  } catch (err) {
    await message.reply('❌ No pude enviarte un DM. Activa los mensajes directos de este servidor e intenta de nuevo.');
  }
});

// Paso 2: Escuchar la respuesta por DM con la contraseña
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== 1) return; // 1 = DM
  if (!registrosPendientes.has(message.author.id)) return;

  const password = message.content.trim();

  if (password.length < 8) {
    return message.reply('⚠️ La contraseña debe tener al menos 8 caracteres. Intenta de nuevo.');
  }

  const datos = registrosPendientes.get(message.author.id);

  // Crear el usuario en Supabase Auth
  const { data, error } = await supabase.auth.admin.createUser({
    email: datos.gmail,
    password: password,
    email_confirm: true,
    user_metadata: {
      discord_id: message.author.id,
      nick_minecraft: datos.nick,
      rango: datos.rango,
      invitado_por: datos.quienTeMetio,
    }
  });

  if (error) {
    console.error(error);
    return message.reply(`❌ Hubo un error creando tu cuenta: ${error.message}`);
  }

  // Guardar los datos extra en la tabla perfiles
  const { error: perfilError } = await supabase
    .from('perfiles')
    .insert({
      id: data.user.id,
      discord_id: message.author.id,
      nick_minecraft: datos.nick,
      rango: datos.rango,
      invitado_por: datos.quienTeMetio,
    });

  if (perfilError) {
    console.error(perfilError);
    registrosPendientes.delete(message.author.id);
    return message.reply('⚠️ Tu cuenta se creó, pero hubo un error guardando tus datos extra. Contacta a alegame.');
  }

  registrosPendientes.delete(message.author.id);
  return message.reply('✅ ¡Cuenta creada! Ya puedes entrar a la página de la guía con tu correo y contraseña.');
});

const ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID; // rol que puede usar este comando

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'deleted') return;

  // Verificación de permisos: solo quien tenga el rol de admin puede usarlo
  if (!interaction.member.roles.cache.has(ADMIN_ROLE_ID)) {
    return interaction.reply({
      content: '❌ No tienes permiso para usar este comando.',
      ephemeral: true,
    });
  }

  const usuario = interaction.options.getUser('usuario');
  await interaction.deferReply({ ephemeral: true });

  try {
    // Buscar el perfil por discord_id para obtener su UUID de auth
    const { data: perfil, error: buscarError } = await supabase
      .from('perfiles')
      .select('id')
      .eq('discord_id', usuario.id)
      .single();

    if (buscarError || !perfil) {
      return interaction.editReply(`⚠️ No se encontró ningún registro para ${usuario.tag}.`);
    }

    // Eliminar la cuenta de Supabase Auth
    const { error: authError } = await supabase.auth.admin.deleteUser(perfil.id);

    if (authError) {
      console.error(authError);
      return interaction.editReply(`❌ Error eliminando la cuenta de autenticación: ${authError.message}`);
    }

    // Eliminar el perfil de la tabla (por si acaso el CASCADE no se disparó)
    const { error: perfilError } = await supabase
      .from('perfiles')
      .delete()
      .eq('discord_id', usuario.id);

    if (perfilError) {
      console.error(perfilError);
      return interaction.editReply(`⚠️ Cuenta eliminada, pero hubo un error limpiando el perfil: ${perfilError.message}`);
    }

    // Opcional: también quitar los roles asignados al registrarse
    try {
      const member = await interaction.guild.members.fetch(usuario.id);
      await member.roles.remove([process.env.ROL_ID_1, process.env.ROL_ID_2]);
    } catch (roleErr) {
      console.error('No se pudieron quitar roles (quizás ya no está en el servidor):', roleErr);
    }

    return interaction.editReply(`✅ Se eliminó correctamente el registro de ${usuario.tag}.`);

  } catch (err) {
    console.error(err);
    return interaction.editReply('❌ Ocurrió un error inesperado eliminando el registro.');
  }
});

client.login(process.env.DISCORD_TOKEN);