export const makeSessionKey = (deviceId: string, threadId: string): string =>
  `${deviceId}::${threadId}`;
