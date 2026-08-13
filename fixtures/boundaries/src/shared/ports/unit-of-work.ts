export type TxScope = { readonly __brand: 'TxScope' };
export interface UnitOfWorkPort {
  withTenant<T>(companyId: string, fn: (tx: TxScope) => Promise<T>): Promise<T>;
  withoutTenant<T>(fn: (tx: TxScope) => Promise<T>): Promise<T>;
}
