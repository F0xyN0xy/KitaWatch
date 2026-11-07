import { useEffect, useRef } from 'react';

type HCaptchaApi = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      theme?: 'light' | 'dark';
      callback: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: (error?: string) => void;
    },
  ) => number;
  reset: (widgetId?: number) => void;
};

declare global {
  interface Window {
    hcaptcha?: HCaptchaApi;
    __kitawatchHCaptchaOnLoad?: () => void;
  }
}

let hcaptchaScriptPromise: Promise<void> | null = null;

function loadHCaptchaScript(): Promise<void> {
  if (window.hcaptcha) return Promise.resolve();
  if (hcaptchaScriptPromise) return hcaptchaScriptPromise;

  hcaptchaScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');

    window.__kitawatchHCaptchaOnLoad = () => {
      delete window.__kitawatchHCaptchaOnLoad;
      if (window.hcaptcha) resolve();
      else reject(new Error('hCaptcha loaded without its API being available.'));
    };

    script.src =
      'https://js.hcaptcha.com/1/api.js?onload=__kitawatchHCaptchaOnLoad&render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.kitawatchHcaptcha = 'true';
    script.onerror = () => {
      delete window.__kitawatchHCaptchaOnLoad;
      script.remove();
      reject(new Error('Could not load the hCaptcha script.'));
    };
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    hcaptchaScriptPromise = null;
    throw error;
  });

  return hcaptchaScriptPromise;
}

interface HCaptchaWidgetProps {
  sitekey: string;
  onVerify: (token: string) => void | Promise<void>;
  onExpire?: () => void;
  onError?: (message: string) => void;
}

export default function HCaptchaWidget({
  sitekey,
  onVerify,
  onExpire,
  onError,
}: HCaptchaWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<number | null>(null);
  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);

  onVerifyRef.current = onVerify;
  onExpireRef.current = onExpire;
  onErrorRef.current = onError;

  useEffect(() => {
    let disposed = false;

    void loadHCaptchaScript()
      .then(() => {
        if (disposed || !containerRef.current || !window.hcaptcha) return;

        const widgetId = window.hcaptcha.render(containerRef.current, {
          sitekey,
          theme: 'dark',
          callback: (token) => {
            void Promise.resolve(onVerifyRef.current(token)).finally(() => {
              if (!disposed && widgetIdRef.current !== null) {
                // hCaptcha tokens are single-use; require a fresh challenge
                // after every Supabase sign-in attempt.
                window.hcaptcha?.reset(widgetIdRef.current);
              }
            });
          },
          'expired-callback': () => onExpireRef.current?.(),
          'error-callback': (error) => {
            onErrorRef.current?.(error || 'The hCaptcha challenge failed to load.');
          },
        });

        widgetIdRef.current = widgetId;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          onErrorRef.current?.(
            error instanceof Error ? error.message : 'Could not load hCaptcha.',
          );
        }
      });

    return () => {
      disposed = true;
      if (widgetIdRef.current !== null) {
        window.hcaptcha?.reset(widgetIdRef.current);
        containerRef.current?.replaceChildren();
        widgetIdRef.current = null;
      }
    };
  }, [sitekey]);

  return <div ref={containerRef} className="min-h-[78px]" />;
}
