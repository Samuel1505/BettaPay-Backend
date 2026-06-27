// Shared Type Definitions for BettaPay — single source of truth for TS types

export * from '@bettapay/validation';

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];
export type ID = string;
export type Currency = string;
