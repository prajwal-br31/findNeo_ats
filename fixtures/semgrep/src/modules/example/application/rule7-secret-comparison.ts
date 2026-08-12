// RULE 7 (ER-052): secret compared with ===
declare const providedToken: string;
declare const storedTokenHash: string;
export const bad = providedToken === storedTokenHash;
