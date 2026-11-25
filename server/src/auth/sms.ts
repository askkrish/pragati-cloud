import { config } from '../config.ts';
import { AppError } from '../errors.ts';

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

// Until SMS is set up, real communities cannot sign in; demo communities show the code on screen.
class NoSms implements SmsSender {
  async sendOtp(): Promise<void> {
    throw new AppError(503, 'Sign-in by SMS is not switched on yet for this community. Please contact the association office.', 'sms_off');
  }
}

export function createSms(): SmsSender {
  if (config.sms.provider === 'msg91') return new Msg91Sms();
  if (config.sms.provider === 'none') return new NoSms();
  return new ConsoleSms();
}
