// Общий интерфейс брокера: бумажного и настоящего.

export interface Fill { id: string; price: number; amount: number; cost: number }
export type Side = "buy" | "sell";
export type LimitStatus = "open" | "filled" | "gone";

/** Открытый лимитный ордер, который бот ведёт между проверками (хранится в state). */
export interface Pending {
  side: Side;
  id: string;
  price: number;
  amount: number;
  budget: number; // для покупки: сколько USDT собирались потратить
  placedAt: number;
  deadline: number;
  before: { base: number; quote: number }; // балансы до выставления ордера
  day: string;
  close: number;
  ma: number;
  note: string; // пометки (опоздание, лимит суммы) для итогового уведомления
}

export interface Broker {
  base: string;
  quote: string;
  price(): Promise<number>;
  balances(): Promise<{ base: number; quote: number }>;
  buy(cost: number): Promise<Fill>;
  sellAll(): Promise<Fill>;
  /** Выставить лимитный ордер. Возвращает id и цену/количество после округления. */
  placeLimit(side: Side, price: number, amount: number): Promise<{ id: string; price: number; amount: number }>;
  limitStatus(p: Pending, nowMs: number): Promise<LimitStatus>;
  cancelLimit(p: Pending): Promise<void>;
}
