export type Release = { id: string; title: string; subtitle?: string; items: string[]; en?: { title: string; items: string[] } };

/** Changelog shown in the 'Novedades' modal. Newest first; the id must change for each release. */
export const RELEASES: Release[] = [
  // releases.kapsoExit (P-009-KC): shown after the cutover deploy.
  {
    id: '2026-10-31-kapso-exit',
    title: 'Novedades',
    items: [
      'La bandeja ahora se conecta directamente con WhatsApp (Meta), sin intermediarios.',
      'Todo el historial de chats, contactos, fotos y archivos se conserva en nuestro propio servidor.',
      "Nueva pestaña 'Fuera de turno': los mensajes que llegan fuera del horario esperan ahí, los más antiguos primero.",
      'Fuera del horario de atención (lunes a viernes de 7:00 a. m. a 5:00 p. m. y sábados de 7:00 a. m. a 12:00 m.), el cliente recibe un aviso automático una sola vez.',
      "Los administradores pueden ajustar el horario y el mensaje en 'Horario y fuera de turno'.",
    ],
    en: {
      title: "What's new",
      items: [
        'The inbox now connects directly to WhatsApp (Meta), with no intermediary.',
        'All chat history, contacts, photos and files are kept on our own server.',
        "New 'Fuera de turno' (After hours) tab: messages that arrive outside office hours wait there, oldest first.",
        'Outside office hours (Monday to Friday 7:00 a.m.–5:00 p.m., Saturday 7:00 a.m.–12:00 p.m.), the customer gets one automatic notice.',
        "Admins can change the hours and the message under 'Horario y fuera de turno'.",
      ],
    },
  },
  {
    id: '2026-10-20',
    title: 'Novedades',
    items: [
      'Botón de ojo para mostrar u ocultar la contraseña.',
      'Tabla de usuarios más ordenada, con un menú de acciones.',
      "La lista de chats abre por defecto en la pestaña 'Sin asignar'.",
      'Nueva página de métricas para líderes y administradores.',
    ],
  },
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
