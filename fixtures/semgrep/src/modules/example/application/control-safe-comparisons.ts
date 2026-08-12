// Legal: comparing a token *type* to a literal is not a secret comparison
declare const tokenType: string;
declare const refreshToken: string | null;
export const ok1 = tokenType === 'bearer';
export const ok2 = refreshToken === null;
