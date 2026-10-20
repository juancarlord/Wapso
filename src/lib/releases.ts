export type Release = { id: string; title: string; subtitle?: string; items: string[] };

/** Changelog shown in the 'Novedades' modal. Newest first; the id must change for each release. */
export const RELEASES: Release[] = [
  {
    id: '2026-10-19',
    title: 'Bienvenido a la nueva versión de su Contact Center',
    subtitle: 'Ahora con tecnología de Tekobo',
    items: [
      'Inicio de sesión y usuarios con roles (Administrador, Líder y Agente).',
      'El nombre del agente aparece en cada mensaje enviado (solo lo ve el equipo).',
      'Colores de Mundo Radiológico y modo oscuro.',
      'Notificaciones y puntos de mensajes sin leer.',
      'Envío instantáneo con el estado de cada mensaje.',
      'Imágenes y archivos más claros, con visor de imágenes.',
      'Asignación de chats y lista de chats resueltos.',
    ],
  },
];

export const LATEST_RELEASE_ID = RELEASES[0]?.id ?? '';
