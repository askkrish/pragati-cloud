import { config } from '../config.ts';

export interface SmsSender {
  sendOtp(phoneE164: string, code: string, platformName: string): Promise<void>;
}

// Development: prints the code to the server log.
class ConsoleSms implements SmsSender {
  async sendOtp(phone: string, code: string, platformName: string) {
    console.log(`[sms] ${platformName} sign-in code for ${phone.slice(0, 5)}*****${phone.slice(-2)}: ${code}`);
  }
}

// MSG91 OTP flow. Indian SMS needs a DLT-registered template; MSG91_TEMPLATE_ID is that template,
// with the code passed as the "otp" variable and the platform name as "platform".
class Msg91Sms implements SmsSender {
  async sendOtp(phone: string, code: string, platformName: string) {
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: config.sms.msg91AuthKey, 'content-type': 'application/json' },
      body: JSON.stringify({ template_id: config.sms.msg91TemplateId, short_url: '0',
        recipients: [{ mobiles: phone.replace('+', ''), otp: code, platform: platformName }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`SMS provider returned ${res.status}`);
  }
}

export function createSms(): SmsSender {
  return config.sms.provider === 'msg91' ? new Msg91Sms() : new ConsoleSms();
}
