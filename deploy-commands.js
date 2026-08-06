import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('deleted')
    .setDescription('Elimina el registro (correo y cuenta) de un usuario')
    .addUserOption(option =>
      option.setName('usuario')
        .setDescription('El usuario a eliminar')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(0) // oculto por defecto, se configura por rol en el servidor
    .toJSON(),
];

const rest = new REST().setToken(process.env.DISCORD_TOKEN);

try {
  console.log('Registrando comando /deleted...');

  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );

  console.log('✅ Comando registrado con éxito.');
} catch (error) {
  console.error(error);
}