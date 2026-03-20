import type { Env } from '../types';
import { TelegramClient } from './client';

export async function downloadFromTelegram(
  fileId: string,
  env: Env,
): Promise<Response> {
  const tg = new TelegramClient(env);
  return tg.downloadFile(fileId);
}
