type FacebookBotCredentials = {
  email: string;
  password: string;
  twoFactorSecret?: string;
};

declare global {
  interface Window {
    api: {
      startFacebookBot: (credentials: FacebookBotCredentials) => Promise<string>;
      onBotLog: (listener: (message: string) => void) => () => void;
    };
  }
}

export {};
