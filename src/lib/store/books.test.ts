import { describe, expect, it } from "vitest";
import { booksFrom, newAccount, newBooks, syncCombined } from "./account";

/**
 * These exist for one bug: the migration returned the stored account *as*
 * the swing book, so the combined view and that book were the same object.
 * `syncCombined` then summed the pair into one of its own halves — the swing
 * balance absorbed the scalp's $100 on every call, and because the tick calls
 * it three times it compounded. Two $100 books read as a $500 account within
 * minutes of deploying, and the inflation was persisted.
 */
describe("books", () => {
  it("migrates a single account into the swing book without aliasing it", () => {
    const legacy = newAccount(100);
    legacy.balance = 98.66;
    const books = booksFrom(null, legacy, 100);

    expect(books.swing).not.toBe(legacy);
    expect(books.swing.balance).toBe(98.66);
    expect(books.swing.startingBalance).toBe(100);
    // Everything the old account traded was the swing engine's, so the scalp
    // starts fresh rather than inheriting half a history it never had.
    expect(books.scalp.balance).toBe(100);
    expect(books.scalp.realisedPnl).toBe(0);
  });

  it("does not alias the books it reads back", () => {
    const stored = newBooks(100);
    const books = booksFrom(stored, null, 100);
    expect(books.swing).not.toBe(stored.swing);
    expect(books.scalp).not.toBe(stored.scalp);
  });

  it("sums the books without touching them", () => {
    const books = newBooks(100);
    books.swing.balance = 90;
    books.swing.realisedPnl = -10;
    books.scalp.balance = 105;
    books.scalp.realisedPnl = 5;

    const combined = syncCombined(newAccount(200), books);
    expect(combined.balance).toBe(195);
    expect(combined.startingBalance).toBe(200);
    expect(combined.realisedPnl).toBe(-5);
    // The parts are untouched, however many times the sum is taken.
    expect(books.swing.balance).toBe(90);
    expect(books.scalp.balance).toBe(105);
  });

  it("is idempotent — the balance does not grow by re-reading it", () => {
    const books = newBooks(100);
    const combined = newAccount(200);
    syncCombined(combined, books);
    const once = combined.balance;
    syncCombined(combined, books);
    syncCombined(combined, books);
    expect(combined.balance).toBe(once);
    expect(combined.startingBalance).toBe(200);
  });

  it("refuses to sum into one of its own books", () => {
    const books = newBooks(100);
    expect(() => syncCombined(books.swing, books)).toThrow(/must not be one of the books/);
    expect(() => syncCombined(books.scalp, books)).toThrow(/must not be one of the books/);
  });

  it("halts the pair only when both books are halted", () => {
    const books = newBooks(100);
    books.swing.haltedReason = "max drawdown 31% reached";
    expect(syncCombined(newAccount(200), books).haltedReason).toBeNull();
    books.scalp.haltedReason = "max drawdown 33% reached";
    expect(syncCombined(newAccount(200), books).haltedReason).toContain("swing");
  });
});
