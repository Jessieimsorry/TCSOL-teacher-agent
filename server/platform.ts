import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
export function defaultDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  if (env.CTT_DATA_DIR) return env.CTT_DATA_DIR;
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'ChineseTeachingTeam');
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', 'ChineseTeachingTeam');
  return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'ChineseTeachingTeam');
}
