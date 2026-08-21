"use client";

import { useEffect, useRef } from "react";
import { marketStream, type StreamType } from "./marketStream";

/** Subscribe to one stream type; handler is kept in a ref so it never churns the subscription. */
export function useMarketSub<T = unknown>(type: StreamType, handler: (data: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    return marketStream.subscribe((t, d) => {
      if (t === type) ref.current(d as T);
    });
  }, [type]);
}

/** Point the shared connection at a symbol/interval (call once, at the page level). */
export function useStreamTarget(symbol: string, interval: string) {
  useEffect(() => {
    marketStream.ensure(symbol, interval);
  }, [symbol, interval]);
}

// Raw Binance WS payload shapes we consume.
export interface WsTicker { c: string; P: string; h: string; l: string; v: string; q: string; b?: string; a?: string }
export interface WsDepth { bids: [string, string][]; asks: [string, string][] }
export interface WsTrade { t: number; p: string; q: string; T: number; m: boolean }
export interface WsKline { k: { t: number; o: string; h: string; l: string; c: string; v: string; x: boolean } }
