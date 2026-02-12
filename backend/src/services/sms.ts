import twilio from 'twilio';
import { config } from '../config';

let client: ReturnType<typeof twilio> | null = null;

function getClient() {
  if (!client && config.twilioAccountSid && config.twilioAuthToken) {
    client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  }
  return client;
}

export async function sendAlertSms(
  to: string,
  keyword: string,
  matchCount: number,
  firstMatchUrl: string
): Promise<void> {
  const twilioClient = getClient();
  if (!twilioClient) {
    throw new Error('Twilio not configured');
  }

  const body = `[FirearmAlert] ${matchCount} match${matchCount > 1 ? 'es' : ''} found for "${keyword}": ${firstMatchUrl}`;

  await twilioClient.messages.create({
    body,
    from: config.twilioFromNumber,
    to,
  });
}
