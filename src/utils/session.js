// Sessão emitida antes da última troca de senha deixa de valer. A comparação é em segundos (precisão do `iat` do JWT).
export const issuedBeforePasswordChange = (passwordChangedAt, iat) =>
  Boolean(passwordChangedAt) && iat < Math.floor(passwordChangedAt.getTime() / 1000);
