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
  notificationId: string,
  backendUrl: string
): Promise<void> {
  const twilioClient = getClient();
  if (!twilioClient) {
    throw new Error('Twilio not configured');
  }

  const landingUrl = `${backendUrl}/notifications/${notificationId}`;
  const body = `[FirearmAlert] ${matchCount} NEW item${matchCount > 1 ? 's' : ''} for "${keyword}": ${landingUrl}`;

  await twilioClient.messages.create({
    body,
    from: config.twilioFromNumber,
    to,
  });
}
