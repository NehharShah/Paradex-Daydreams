// most stuff here is taken from
// https://github.com/tradeparadex/code-samples/tree/main/typescript

import BigNumber from "bignumber.js";
import type { ParadexAccount, ParadexConfig } from "./types";
import {
    ec,
    shortString,
    type TypedData,
    typedData as starkTypedData,
    Account,
} from "starknet";
import { StarknetChain } from "@daydreamsai/core";
import { Logger, LogLevel } from "@daydreamsai/core";

interface AuthRequest extends Record<string, unknown> {
    method: string;
    path: string;
    body: string;
    timestamp: number;
    expiration: number;
}

interface MarketData {
    symbol: string;
    last_price: string;
    mark_price: string;
    index_price: string;
    open_interest: string;
    funding_rate: string;
    volume_24h: string;
    trades_24h: string;
    price_change_24h: string;
}

interface RiskBand {
    level: 'LOW' | 'MEDIUM' | 'HIGH';
    maxPositionSize: number;
    stopLossPercent: number;
}

interface PositionLimits {
    maxLeverage: number;
    maxPositionValue: number;
    recommendedPositionSize: number;
    riskBand: RiskBand;
}

interface AnalysisResult {
    recommendation: 'BUY' | 'SELL' | 'HOLD';
    confidence: number;
    reasoning: string;
    metrics: {
        volatility: number;
        momentum: number;
        volume_trend: number;
    };
    positionLimits: PositionLimits;
}

// Add new interface for batch orders
interface BatchOrderResult {
    orderId: string;
    market: string;
    status: string;
    error?: string;
}

const DOMAIN_TYPES = {
    StarkNetDomain: [
        { name: "name", type: "felt" },
        { name: "chainId", type: "felt" },
        { name: "version", type: "felt" },
    ],
};
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

//
// public
//

export async function authenticate(config: ParadexConfig, account: ParadexAccount) {
    const { signature, timestamp, expiration } = signAuthRequest(
        config,
        account,
    );
    const headers = {
        Accept: "application/json",
        "PARADEX-STARKNET-ACCOUNT": account.address,
        "PARADEX-STARKNET-SIGNATURE": signature,
        "PARADEX-TIMESTAMP": timestamp.toString(),
        "PARADEX-SIGNATURE-EXPIRATION": expiration.toString(),
        "Content-Type": "application/json"
    };

    try {
        const response = await fetch(`${config.apiBaseUrl}/auth`, {
            method: "POST",
            headers,
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Authentication failed: ${response.status} - ${errorData.message || response.statusText}`);
        }

        const data = await response.json();
        if (!data.jwt_token) {
            throw new Error('No JWT token received from authentication');
        }
        return data.jwt_token;
    } catch (e) {
        console.error('Authentication error:', e);
        throw e;
    }
}

// https://docs.paradex.trade/api-reference/prod/account/get
export async function getAccountInfo(config: ParadexConfig, account: ParadexAccount) {
    if (!account.jwtToken) {
        throw new Error('No JWT token available. Please authenticate first.');
    }

    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${account.jwtToken}`,
    };

    try {
        const response = await fetch(`${config.apiBaseUrl}/account`, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Failed to get account info: ${response.status} - ${errorData.message || response.statusText}`);
        }

        const data = await response.json();
        if (!data) {
            throw new Error('No account data received');
        }
        return data;
    } catch (e) {
        console.error('Get account info error:', e);
        throw e;
    }
}

// https://docs.paradex.trade/api-reference/prod/markets/get-markets
export async function listAvailableMarkets(
    config: ParadexConfig,
    market?: string,
) {
    const headers = {
        Accept: "application/json",
    };

    try {
        const url = market
            ? `${config.apiBaseUrl}/markets?market=${market}`
            : `${config.apiBaseUrl}/markets`;

        const response = await fetch(url, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        if (!data.results) {
            throw new Error('No results found in response');
        }
        return data.results;
    } catch (e) {
        console.error('Error fetching markets:', e);
        throw e; // Propagate the error instead of swallowing it
    }
}

// https://docs.paradex.trade/api-reference/prod/account/get-positions
export async function getPositions(config: ParadexConfig, account: ParadexAccount) {
    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${account.jwtToken}`,
    };

    try {
        const response = await fetch(`${config.apiBaseUrl}/positions`, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.results;
    } catch (e) {
        console.error(e);
    }
}

// https://docs.paradex.trade/api-reference/prod/orders/get-open-orders
export async function getOpenOrders(config: ParadexConfig, account: ParadexAccount) {
    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${account.jwtToken}`,
    };

    try {
        const response = await fetch(`${config.apiBaseUrl}/orders`, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.results;
    } catch (e) {
        console.error(e);
    }
}

// https://docs.paradex.trade/api-reference/prod/orders/new
export async function openOrder(
    config: ParadexConfig,
    account: ParadexAccount,
    orderDetails: Record<string, string>,
) {
    // Validate price before proceeding
    const price = Number(orderDetails.price);
    if (price <= 0) {
        throw new Error("Order failed: price must be a non-negative non-zero number.");
    }

    const timestamp = Date.now();
    const signature = signOrder(config, account, orderDetails, timestamp);

    const inputBody = JSON.stringify({
        ...orderDetails,
        signature: signature,
        signature_timestamp: timestamp,
    });

    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${account.jwtToken}`,
        "Content-Type": "application/json",
    };

    try {
        const response = await fetch(`${config.apiBaseUrl}/orders`, {
            method: "POST",
            headers,
            body: inputBody,
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(`Order failed: ${data.message || response.status}`);
        }

        // Log the full response to see what's available
        console.log("Order response:", data);
        
        // Return the full data object or specific fields
        return {
            orderId: data.orderId || data.id || 'filled-immediately',
            status: data.status || 'success',
            data: data
        };
    } catch (error) {
        console.error('Error in openOrder:', error);
        throw error;
    }
}

// https://docs.paradex.trade/api-reference/prod/orders/cancel
export async function cancelOrder(
    config: ParadexConfig,
    account: ParadexAccount,
    orderId: string,
) {
    const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${account.jwtToken}`,
    };

    try {
        const response = await fetch(`${config.apiBaseUrl}/orders/${orderId}`, {
            method: "DELETE",
            headers,
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return true;
    } catch (e) {
        console.error(e);
    }
}

// Add this helper function to calculate position limits and risk bands
function calculatePositionLimits(
    marketData: MarketData,
    accountValue: number,
    volatility: number
): PositionLimits {
    // Base max leverage on volatility
    const baseMaxLeverage = 20; // Maximum leverage allowed
    const volatilityAdjustedLeverage = Math.min(
        baseMaxLeverage,
        baseMaxLeverage * (1 - volatility * 5)
    );

    // Calculate maximum position value (in USD)
    const maxPositionValue = accountValue * volatilityAdjustedLeverage;

    // Determine risk band based on volatility and market conditions
    let riskBand: RiskBand;
    if (volatility < 0.02) {
        riskBand = {
            level: 'LOW',
            maxPositionSize: accountValue * 0.5,
            stopLossPercent: 2
        };
    } else if (volatility < 0.05) {
        riskBand = {
            level: 'MEDIUM',
            maxPositionSize: accountValue * 0.3,
            stopLossPercent: 5
        };
    } else {
        riskBand = {
            level: 'HIGH',
            maxPositionSize: accountValue * 0.1,
            stopLossPercent: 10
        };
    }

    // Calculate recommended position size based on risk band
    const recommendedPositionSize = Math.min(
        riskBand.maxPositionSize,
        maxPositionValue * 0.25 // Use 25% of max position value as recommended size
    );

    return {
        maxLeverage: volatilityAdjustedLeverage,
        maxPositionValue,
        recommendedPositionSize,
        riskBand
    };
}

// Update the analyzeMarket function
export async function analyzeMarket(
    config: ParadexConfig,
    market: string,
    account?: ParadexAccount // Make account optional
): Promise<AnalysisResult> {
    try {
        const marketData = await listAvailableMarkets(config, market);
        if (!marketData || !marketData[0]) {
            throw new Error(`No data available for market ${market}`);
        }

        const data = marketData[0] as MarketData;
        
        // Get account value if account is provided
        let accountValue = 10000; // Default value
        if (account) {
            const accountInfo = await getAccountInfo(config, account);
            accountValue = parseFloat(accountInfo.account_value);
        }

        // Calculate basic metrics
        const lastPrice = parseFloat(data.last_price);
        const markPrice = parseFloat(data.mark_price);
        const indexPrice = parseFloat(data.index_price);
        const fundingRate = parseFloat(data.funding_rate);
        const volume24h = parseFloat(data.volume_24h);
        const priceChange24h = parseFloat(data.price_change_24h);

        // Calculate analysis metrics
        const volatility = Math.abs((markPrice - indexPrice) / indexPrice);
        const momentum = priceChange24h / lastPrice;
        const volumeTrend = volume24h / (lastPrice * parseFloat(data.open_interest));

        // Determine recommendation
        let recommendation: 'BUY' | 'SELL' | 'HOLD';
        let confidence = 0;
        let reasoning = '';

        // Analysis logic
        if (momentum > 0.02 && fundingRate < 0.001) {
            recommendation = 'BUY';
            confidence = Math.min(0.8, Math.abs(momentum) * 5);
            reasoning = 'Positive momentum with reasonable funding rate';
        } else if (momentum < -0.02 && fundingRate > 0.001) {
            recommendation = 'SELL';
            confidence = Math.min(0.8, Math.abs(momentum) * 5);
            reasoning = 'Negative momentum with high funding rate';
        } else {
            recommendation = 'HOLD';
            confidence = 0.5;
            reasoning = 'Market conditions are neutral';
        }

        // Add volume analysis
        if (volumeTrend > 0.1) {
            confidence += 0.1;
            reasoning += ' with strong volume support';
        }

        // Add volatility consideration
        if (volatility > 0.02) {
            confidence -= 0.2;
            reasoning += ' (Note: High volatility detected)';
        }

        // Calculate position limits
        const positionLimits = calculatePositionLimits(
            data,
            accountValue,
            volatility
        );

        // Adjust confidence based on risk band
        if (positionLimits.riskBand.level === 'HIGH') {
            confidence *= 0.8; // Reduce confidence in high-risk conditions
            reasoning += ' (High risk conditions - exercise caution)';
        }

        return {
            recommendation,
            confidence: Number(confidence.toFixed(2)),
            reasoning,
            metrics: {
                volatility: Number(volatility.toFixed(4)),
                momentum: Number(momentum.toFixed(4)),
                volume_trend: Number(volumeTrend.toFixed(4))
            },
            positionLimits
        };
    } catch (error) {
        console.error('Error in market analysis:', error);
        throw error;
    }
}

// Add new function for batch order execution
export async function executeBatchOrders(
    config: ParadexConfig,
    account: ParadexAccount,
    orders: Array<{
        market: string;
        side: string;
        type: string;
        size: string;
        price?: string;
        timeInForceType?: string;
    }>
): Promise<BatchOrderResult[]> {
    // Execute orders in parallel with Promise.all
    const results = await Promise.all(
        orders.map(async (orderDetails): Promise<BatchOrderResult> => {
            try {
                const result = await openOrder(config, account, orderDetails);
                return {
                    orderId: result.orderId,
                    market: orderDetails.market,
                    status: result.status
                };
            } catch (error) {
                return {
                    orderId: '',
                    market: orderDetails.market,
                    status: 'FAILED',
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        })
    );

    return results;
}

//
// private
//

// Utility function to generate current and expiration timestamps
function generateTimestamps(): {
    timestamp: number;
    expiration: number;
} {
    const dateNow = new Date();
    const dateExpiration = new Date(dateNow.getTime() + SEVEN_DAYS_MS);

    return {
        timestamp: Math.floor(dateNow.getTime() / 1000),
        expiration: Math.floor(dateExpiration.getTime() / 1000),
    };
}

function signAuthRequest(
    config: ParadexConfig,
    account: ParadexAccount,
): {
    signature: string;
    timestamp: number;
    expiration: number;
} {
    const { timestamp, expiration } = generateTimestamps();

    const request: AuthRequest = {
        method: "POST",
        path: "/v1/auth",
        body: "", // Assuming no body is required for this request
        timestamp,
        expiration,
    };

    const typedData = buildAuthTypedData(request, config.starknet.chainId);
    const signature = signatureFromTypedData(account, typedData);

    return { signature, timestamp, expiration };
}

function signOrder(
    config: ParadexConfig,
    account: ParadexAccount,
    orderDetails: Record<string, string>,
    timestamp: number,
): string {
    const sideForSigning = orderDetails.side === "BUY" ? "1" : "2";

    const priceForSigning = toQuantums(orderDetails.price ?? "0", 8);
    const sizeForSigning = toQuantums(orderDetails.size, 8);
    const orderTypeForSigning = shortString.encodeShortString(
        orderDetails.type,
    );
    const marketForSigning = shortString.encodeShortString(orderDetails.market);

    const message = {
        timestamp: timestamp,
        market: marketForSigning,
        side: sideForSigning,
        orderType: orderTypeForSigning,
        size: sizeForSigning,
        price: priceForSigning,
    };

    const typedData = buildOrderTypedData(message, config.starknet.chainId);
    const signature = signatureFromTypedData(account, typedData);

    return signature;
}

function buildAuthTypedData(
    message: Record<string, unknown>,
    starknetChainId: string,
) {
    const paradexDomain = buildParadexDomain(starknetChainId);
    return {
        domain: paradexDomain,
        primaryType: "Request",
        types: {
            ...DOMAIN_TYPES,
            Request: [
                { name: "method", type: "felt" }, // string
                { name: "path", type: "felt" }, // string
                { name: "body", type: "felt" }, // string
                { name: "timestamp", type: "felt" }, // number
                { name: "expiration", type: "felt" }, // number
            ],
        },
        message,
    };
}

function buildOrderTypedData(
    message: Record<string, unknown>,
    starknetChainId: string,
) {
    const paradexDomain = buildParadexDomain(starknetChainId);
    return {
        domain: paradexDomain,
        primaryType: "Order",
        types: {
            ...DOMAIN_TYPES,
            Order: [
                { name: "timestamp", type: "felt" }, // UnixTimeMs; Acts as a nonce
                { name: "market", type: "felt" }, // 'BTC-USD-PERP'
                { name: "side", type: "felt" }, // '1': 'BUY'; '2': 'SELL'
                { name: "orderType", type: "felt" }, // 'LIMIT';  'MARKET'
                { name: "size", type: "felt" }, // Quantum value
                { name: "price", type: "felt" }, // Quantum value; '0' for Market order
            ],
        },
        message,
    };
}

function buildParadexDomain(starknetChainId: string) {
    return {
        name: "Paradex",
        chainId: starknetChainId,
        version: "1",
    };
}

function signatureFromTypedData(account: ParadexAccount, typedData: TypedData) {
    const msgHash = starkTypedData.getMessageHash(typedData, account.address);
    const { r, s } = ec.starkCurve.sign(msgHash, account.privateKey);
    return JSON.stringify([r.toString(), s.toString()]);
}

/**
 * Convert to quantums rounding final number down.
 *
 * @param amount Amount in human numbers
 * @param precision How many decimals the target contract works with
 * @returns Quantum value
 */
export function toQuantums(
    amount: BigNumber | string,
    precision: number,
): string {
    const bnAmount = typeof amount === "string" ? BigNumber(amount) : amount;
    const bnQuantums = bnAmount.multipliedBy(new BigNumber(10).pow(precision));
    return bnQuantums.integerValue(BigNumber.ROUND_FLOOR).toString();
}

export class ParadexClient {
    private chain: StarknetChain;
    private logger: Logger;
    private config: ParadexConfig;

    constructor(config: ParadexConfig, account: ParadexAccount) {
        this.config = config;
        this.chain = new StarknetChain({
            rpcUrl: config.apiBaseUrl,
            address: account.address,
            privateKey: account.privateKey
        });

        // Initialize logger
        this.logger = new Logger({
            level: LogLevel.INFO,
            enableColors: true
        });
    }

    // Wrap existing functions to use the chain interface
    async listAvailableMarkets(market?: string) {
        try {
            const result = await this.chain.read({
                contractAddress: this.config.apiBaseUrl,
                entrypoint: "markets",
                calldata: market ? [market] : []
            });

            this.logger.info("ParadexClient", "Markets fetched", { market });
            return result;
        } catch (error) {
            this.logger.error("ParadexClient", "Failed to fetch markets", { error });
            throw error;
        }
    }

    async openOrder(orderDetails: Record<string, string>) {
        try {
            const result = await this.chain.write({
                contractAddress: this.config.apiBaseUrl,
                entrypoint: "orders",
                calldata: [orderDetails]
            });

            this.logger.info("ParadexClient", "Order placed", { orderDetails });
            return result;
        } catch (error) {
            this.logger.error("ParadexClient", "Failed to place order", { error });
            throw error;
        }
    }

    // ... implement other methods similarly
}