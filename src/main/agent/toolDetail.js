'use strict';

/** Short label for a tool call (query, path, command…) shown on its card. */
function toolDetail(name, args) {
  if (name === 'web_search' || name === 'deep_search' || name === 'open_search') return args.query ?? '';
  if (name === 'grep' || name === 'find') return args.pattern ?? '';
  if (name === 'open_url' || name === 'read_page') return args.url ?? '';
  if (name === 'open_app' || name === 'close_app') return args.app ?? '';
  if (name === 'play_video') return args.video ?? '';
  if (name === 'media_control' || name === 'window_control') return [args.action, args.app || args.player].filter(Boolean).join(' ');
  if (name === 'run_command' || name === 'bash') return args.command ?? '';
  if (name === 'install_software') return args.id || args.name || '';
  if (name === 'create_document') return `${args.filename ?? 'document'}.${args.format ?? 'txt'}`;
  if (name === 'remember') return args.text ?? '';
  if (name === 'screen_record' || name === 'model_profile') return args.action ?? '';
  if (name === 'screenshot') return args.target ?? 'main';
  if (['read_file', 'read_document', 'list_directory', 'read', 'write', 'edit', 'ls'].includes(name)) {
    return args.path ?? args.filename ?? args.dir ?? '';
  }
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

module.exports = { toolDetail };
