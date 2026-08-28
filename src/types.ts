/**
 * Type definitions for tastytrade MCP Server
 */

import {
  Action,
  InstrumentType,
  OrderType,
  TimeInForce,
  PriceEffect,
  Direction,
} from "./enums.js";

/**
 * Configuration for tastytrade client
 */
export interface TastytradeConfig {
  apiUrl: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  sessionToken?: string;
  accountNumber?: string;
}

/**
 * OAuth2 token response
 */
export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

/**
 * Position data
 */
export interface Position {
  symbol: string;
  instrumentType: InstrumentType;
  quantity: number;
  quantityDirection: Direction;
  closePrice: string;
  averageOpenPrice: string;
  multiplier: number;
  underlyingSymbol?: string;
}

/**
 * Order data
 */
export interface Order {
  id: string;
  status: string;
  accountNumber: string;
  timeInForce: TimeInForce;
  orderType: OrderType;
  price?: string;
  priceEffect?: PriceEffect;
  legs: OrderLeg[];
}

/**
 * Order leg data
 */
export interface OrderLeg {
  symbol: string;
  instrumentType: InstrumentType;
  action: Action;
  quantity: number;
}
