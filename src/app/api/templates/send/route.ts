import { extractSentMessageId, recordMessageSender } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { NextResponse } from 'next/server';
import { buildTemplateSendPayload } from '@kapso/whatsapp-cloud-api';
import { whatsappClient, PHONE_NUMBER_ID } from '@/lib/whatsapp-client';
import { safeError } from '@/lib/log';
import { alert } from '@/lib/alert';
import { friendlyResponse, storeOutbound } from '@/lib/outbound';
import { graphErrorCode, isBsuid } from '@/lib/send-rules';
import type { TemplateParameterInfo } from '@/types/whatsapp';

type TemplateSendInput = Parameters<typeof buildTemplateSendPayload>[0];
type TemplateMessageInput = Parameters<(typeof whatsappClient.messages)['sendTemplate']>[0];
type TemplatePayload = TemplateMessageInput['template'];
type TemplateBodyParameter = NonNullable<TemplateSendInput['body']>[number];
type TemplateHeaderParameter = Extract<NonNullable<TemplateSendInput['header']>, { type: 'text' }>;
type TemplateButtonParameter = Extract<NonNullable<TemplateSendInput['buttons']>[number], { subType: 'url' }>;

export async function POST(request: Request) {
  const authUser = await requireUser(request);
  if (authUser instanceof NextResponse) return authUser;

  try {
    const body = await request.json();
    const { to, templateName, languageCode, parameters, parameterInfo } = body;

    if (!to || !templateName || !languageCode) {
      return NextResponse.json(
        { error: 'Missing required fields: to, templateName, languageCode' },
        { status: 400 }
      );
    }

    const templateOptions: TemplateSendInput = {
      name: templateName,
      language: languageCode
    };

    if (parameters && parameterInfo) {
      const typedParamInfo = parameterInfo as TemplateParameterInfo;

      const bodyParameters: TemplateBodyParameter[] = [];
      const buttonParameters: TemplateButtonParameter[] = [];
      let headerParameter: TemplateHeaderParameter | undefined;

      const getParameterValue = (paramName: string, index: number) => {
        if (Array.isArray(parameters)) {
          return parameters[index];
        }
        return parameters[paramName];
      };

      typedParamInfo.parameters.forEach((paramDef, index) => {
        const rawValue = getParameterValue(paramDef.name, index);
        if (rawValue === undefined || rawValue === null) {
          return;
        }

        const textValue = String(rawValue);
        if (!textValue.trim()) {
          return;
        }

        if (paramDef.component === 'HEADER') {
          if (!headerParameter) {
            headerParameter = {
              type: 'text',
              text: textValue,
              parameter_name: paramDef.name
            } as TemplateHeaderParameter;
          }
          return;
        }

        if (paramDef.component === 'BODY') {
          bodyParameters.push({
            type: 'text',
            text: textValue,
            parameter_name: paramDef.name
          } as TemplateBodyParameter);
          return;
        }

        if (paramDef.component === 'BUTTON' && typeof paramDef.buttonIndex === 'number') {
          let button = buttonParameters.find((btn) => btn.index === paramDef.buttonIndex);
          if (!button) {
            button = {
              type: 'button',
              subType: 'url',
              index: paramDef.buttonIndex,
              parameters: []
            } as TemplateButtonParameter;
            buttonParameters.push(button);
          }
          button.parameters.push({
            type: 'text',
            text: textValue,
            parameter_name: paramDef.name
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
        }
      });

      if (headerParameter) {
        templateOptions.header = headerParameter;
      }

      if (bodyParameters.length > 0) {
        templateOptions.body = bodyParameters;
      }

      if (buttonParameters.length > 0) {
        templateOptions.buttons = buttonParameters;
      }
    }

    const templatePayload = buildTemplateSendPayload(templateOptions) as TemplatePayload;

    // Send template message. BSUID recipients (username users) go in `recipient`, not `to` (Meta BSUID doc).
    let result: unknown;
    if (isBsuid(String(to))) {
      const response = await whatsappClient.request('POST', `/${PHONE_NUMBER_ID}/messages`, {
        body: { messaging_product: 'whatsapp', recipient_type: 'individual', recipient: String(to).trim(), type: 'template', template: templatePayload }
      });
      if (!response.ok) {
        let code: number | null = null;
        try { code = graphErrorCode(await response.json()); } catch { /* not json */ }
        safeError('template-send', new Error('send failed'), { status: response.status, code });
        void alert('send_failed', { status: response.status, code });
        return friendlyResponse(code) ?? NextResponse.json({ error: 'Failed to send template message' }, { status: 502 });
      }
      result = await response.json();
    } else {
      result = await whatsappClient.messages.sendTemplate({
        phoneNumberId: PHONE_NUMBER_ID,
        to,
        template: templatePayload
      });
    }

    const sentId = extractSentMessageId(result);
    if (sentId) {
      try { recordMessageSender(sentId, authUser); } catch (e) { safeError('senders', e); }
    }
    storeOutbound(to, sentId, { type: 'template', templateName: String(templateName) });

    return NextResponse.json(result);
  } catch (error) {
    const code = graphErrorCode(error);
    safeError('template-send', error, { code });
    void alert('send_failed', { code });
    const friendly = friendlyResponse(code);
    if (friendly) return friendly;
    return NextResponse.json(
      { error: 'Failed to send template message' },
      { status: 500 }
    );
  }
}
