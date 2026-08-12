// RULE 5 (ER-023): tenant identity taken from the client
declare const req: { body: { companyId: string }; query: { companyId: string } };
export const bad1 = req.body.companyId;
export const bad2 = req.query.companyId;
