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
        throw e;
    }
}

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

export async function openOrder(
    config: ParadexConfig,
    account: ParadexAccount,
    orderDetails: Record<string, string>,
) {
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

        console.log("Order response:", data);

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

function calculatePositionLimits(
    marketData: MarketData,
    accountValue: number,
    volatility: number
): PositionLimits {
    const baseMaxLeverage = 20;
    const volatilityAdjustedLeverage = Math.min(
        baseMaxLeverage,
        baseMaxLeverage * (1 - volatility * 5)
    );

    const maxPositionValue = accountValue * volatilityAdjustedLeverage;

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

    const recommendedPositionSize = Math.min(
        riskBand.maxPositionSize,
        maxPositionValue * 0.25
    );

    return {
        maxLeverage: volatilityAdjustedLeverage,
        maxPositionValue,
        recommendedPositionSize,
        riskBand
    };
}

export async function analyzeMarket(
    config: ParadexConfig,
    market: string,
    account?: ParadexAccount
): Promise<AnalysisResult> {
    try {
        const marketData = await listAvailableMarkets(config, market);
        if (!marketData || !marketData[0]) {
            throw new Error(`No data available for market ${market}`);
        }

        const data = marketData[0] as MarketData;

        let accountValue = 10000;
        if (account) {
            const accountInfo = await getAccountInfo(config, account);
            accountValue = parseFloat(accountInfo.account_value);
        }

        const lastPrice = parseFloat(data.last_price);
        const markPrice = parseFloat(data.mark_price);
        const indexPrice = parseFloat(data.index_price);
        const fundingRate = parseFloat(data.funding_rate);
        const volume24h = parseFloat(data.volume_24h);
        const priceChange24h = parseFloat(data.price_change_24h);

        const volatility = Math.abs((markPrice - indexPrice) / indexPrice);
        const momentum = priceChange24h / lastPrice;
        const volumeTrend = volume24h / (lastPrice * parseFloat(data.open_interest));

        let recommendation: 'BUY' | 'SELL' | 'HOLD';
        let confidence = 0;
        let reasoning = '';

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

        if (volumeTrend > 0.1) {
            confidence += 0.1;
            reasoning += ' with strong volume support';
        }

        if (volatility > 0.02) {
            confidence -= 0.2;
            reasoning += ' (Note: High volatility detected)';
        }

        const positionLimits = calculatePositionLimits(
            data,
            accountValue,
            volatility
        );

        if (positionLimits.riskBand.level === 'HIGH') {
            confidence *= 0.8;
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
        body: "",
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
                { name: "method", type: "felt" },
                { name: "path", type: "felt" },
                { name: "body", type: "felt" },
                { name: "timestamp", type: "felt" },
                { name: "expiration", type: "felt" },
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
                { name: "timestamp", type: "felt" },
                { name: "market", type: "felt" },
                { name: "side", type: "felt" },
                { name: "orderType", type: "felt" },
                { name: "size", type: "felt" },
                { name: "price", type: "felt" },
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

        this.logger = new Logger({
            level: LogLevel.INFO,
            enableColors: true
        });
    }

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
}