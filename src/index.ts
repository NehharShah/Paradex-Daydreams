import { shortString } from "starknet";
import type { ParadexAccount, ParadexConfig } from "./types";
import {
    authenticate,
    getAccountInfo,
    getOpenOrders,
    getPositions,
    listAvailableMarkets,
    openOrder,
    cancelOrder,
} from "./paradex";
import { env } from "./config";
import { groq } from "@ai-sdk/groq";
import {
    action,
    cli,
    createDreams,
    createMemoryStore,
    createVectorStore,
} from "@daydreamsai/core/v1";
import type { Action } from "@daydreamsai/core/v1";
import { z } from "zod";
import { storeOrder, getOrder } from "./memory";

interface ParadexOrder {
    market: string;
    side: string;
    type: string;
    size: string;
    price: string;
}

// Cache for market data to reduce API calls
const marketCache = new Map<string, { data: any, timestamp: number }>();
const CACHE_DURATION = 30000; // 30 seconds cache duration

// Utility function to get markets with caching
async function getCachedMarkets(config: ParadexConfig, market?: string): Promise<any[]> {
    const cacheKey = market || 'all_markets';
    const cached = marketCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
        return cached.data;
    }

    const markets = await listAvailableMarkets(config, market);
    marketCache.set(cacheKey, { data: markets, timestamp: Date.now() });
    return markets;
}

async function paradexLogin(): Promise<
    { config: ParadexConfig; account: ParadexAccount }
> {
    // testnet
    const apiBaseUrl = env.apiBaseUrl;
    const chainId = shortString.encodeShortString(env.starknet.chainId);
    // mainnet, see https://api.prod.paradex.trade/v1/system/config
    // const apiBaseUrl = "https://api.prod.paradex.trade/v1"
    // const chainId = shortString.encodeShortString("PRIVATE_SN_PARACLEAR_MAINNET");

    const config: ParadexConfig = {
        apiBaseUrl,
        starknet: { chainId },
    };

    const account: ParadexAccount = {
        address: process.env.PARADEX_ACCOUNT_ADDRESS || "",
        privateKey: process.env.PARADEX_PRIVATE_KEY || "",
    };

    console.log(`Authenticating Paradex account ${account.address}`);
    account.jwtToken = await authenticate(config, account);

    return { config, account };
}

// Debounced authentication refresh
let authRefreshTimeout: ReturnType<typeof setTimeout>;
async function debouncedAuthRefresh(config: ParadexConfig, account: ParadexAccount) {
    if (authRefreshTimeout) {
        clearTimeout(authRefreshTimeout);
    }
    authRefreshTimeout = setTimeout(async () => {
        try {
            account.jwtToken = await authenticate(config, account);
        } catch (error) {
            console.error('Auth refresh failed:', error);
        }
    }, 1000);
}

// Add rate limiting constants and tracking
const RATE_LIMITS = {
    REQUESTS_PER_MINUTE: 25, // Setting slightly below limit for safety
    REQUESTS_PER_DAY: 950,   // Setting slightly below limit for safety
};

// Rate limiting tracking
const rateLimiter = {
    requestsThisMinute: 0,
    requestsToday: 0,
    lastMinuteTimestamp: Date.now(),
    lastDayTimestamp: Date.now(),

    // Reset counters when appropriate
    resetCounters() {
        const now = Date.now();
        if (now - this.lastMinuteTimestamp >= 60000) {
            this.requestsThisMinute = 0;
            this.lastMinuteTimestamp = now;
        }
        if (now - this.lastDayTimestamp >= 86400000) {
            this.requestsToday = 0;
            this.lastDayTimestamp = now;
        }
    },

    // Check if we can make a request
    canMakeRequest() {
        this.resetCounters();
        return this.requestsThisMinute < RATE_LIMITS.REQUESTS_PER_MINUTE &&
            this.requestsToday < RATE_LIMITS.REQUESTS_PER_DAY;
    },

    // Track a new request
    trackRequest() {
        this.requestsThisMinute++;
        this.requestsToday++;
    }
};

async function main() {
    const { config, account } = await paradexLogin();

    // More efficient interval handling
    const refreshInterval = setInterval(async () => {
        try {
            account.jwtToken = await authenticate(config, account);
        } catch (error) {
            console.error('Auth refresh failed:', error);
        }
    }, 1000 * 60 * 3 - 3000); // refresh every ~3 minutes

    // Proper cleanup
    const cleanup = () => {
        clearInterval(refreshInterval);
        marketCache.clear();
        process.exit(0);
    };

    process.on("SIGTERM", cleanup);
    process.on("SIGINT", cleanup);

    const accountInfo = await getAccountInfo(config, account);
    console.log(`Account:
        Status: ${accountInfo.status}
        Value: ${accountInfo.account_value}
        P&L: ${accountInfo.account_value - accountInfo.total_collateral},
        Free collateral: ${accountInfo.free_collateral}`);
    //console.log(JSON.stringify(accountInfo, null, 2));

    const getAccountInfoAction = action({
        name: "paradex-get-account-info",
        description: "Get account information including value and free collateral",
        schema: z.object({
            text: z.string().describe("Natural language request for account info")
        }),
        handler: async (_call, _ctx, _agent) => {
            try {
                const accountInfo = await getAccountInfo(config, account);
                return {
                    success: true,
                    message: JSON.stringify({
                        text: `Account Status: ${accountInfo.status}\nValue: ${accountInfo.account_value}\nFree Collateral: ${accountInfo.free_collateral}`
                    })
                };
            } catch (error) {
                return {
                    success: false,
                    message: JSON.stringify({ error: String(error) })
                };
            }
        }
    });

    const openOrderAction = action({
        name: "paradex-open-order",
        description: "Open a market or limit order on Paradex. Examples: 'buy 0.1 ETH at market price' or 'buy 0.5 BTC at limit 40000'",
        schema: z.object({
            text: z.string().describe("Natural language description of the order you want to place")
        }),
        handler: async (call, _ctx, _agent) => {
            try {
                const text = call.data.text.toLowerCase();

                // Memoized order pattern regex
                const orderPattern = /\b(buy|sell)\s+(\d+\.?\d*)\s+([a-zA-Z0-9]+)(?:\s+(?:at|@)\s+(market|limit)\s*(?:price\s*)?(?:(\d+\.?\d*))?)?/i;
                const match = text.match(orderPattern);

                if (!match) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: "Invalid order format. Examples:\n" +
                                "'buy 0.1 ETH at market price'\n" +
                                "'sell 0.5 BTC at limit 40000'"
                        })
                    };
                }

                const [, side, size, baseToken, orderType, limitPrice] = match;
                const marketSymbol = `${baseToken.toUpperCase()}-USD-PERP`;

                // Use cached market data
                const availableMarkets = await getCachedMarkets(config);
                const market = availableMarkets.find((m: { symbol: string }) => m.symbol === marketSymbol);

                if (!market) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: `Market ${marketSymbol} is not available. Available markets:\n` +
                                availableMarkets.map((m: { symbol: string }) => m.symbol).join(", ")
                        })
                    };
                }

                // Pre-calculate values for better performance
                const sizeNum = Number(size);
                const sizeIncrement = Number(market.order_size_increment);
                const adjustedSize = Math.max(
                    sizeIncrement,
                    Math.ceil(sizeNum / sizeIncrement) * sizeIncrement
                ).toString();

                // Prepare order details with type assertion
                const orderDetails: Record<string, string> = {
                    market: marketSymbol,
                    side: side.toUpperCase(),
                    size: adjustedSize,
                    timeInForceType: orderType.toLowerCase() === 'market' ? 'IOC' : 'GTC',
                    type: orderType.toLowerCase() === 'limit' ? 'LIMIT' : 'MARKET'
                };

                // Handle limit orders efficiently
                if (orderDetails.type === 'LIMIT') {
                    if (!limitPrice) {
                        return {
                            success: false,
                            message: JSON.stringify({
                                text: "Limit orders require a price. Example: 'buy 0.1 ETH at limit 3000'"
                            })
                        };
                    }

                    const tickSize = Number(market.tick_size);
                    const priceNum = Number(limitPrice);
                    orderDetails.price = (Math.ceil(priceNum / tickSize) * tickSize).toString();

                    // Efficient price validation using cached market data
                    const currentMarket = await getCachedMarkets(config, marketSymbol);
                    const lastPrice = Number(currentMarket[0]?.last_price || 0);

                    if (lastPrice && Math.abs((priceNum - lastPrice) / lastPrice) > 0.1) {
                        return {
                            success: false,
                            message: JSON.stringify({
                                text: `Warning: Your limit price (${orderDetails.price}) deviates significantly from the last price (${lastPrice}). Please confirm the price.`
                            })
                        };
                    }
                }

                // Execute order with proper error handling
                try {
                    const result = await openOrder(config, account, orderDetails);

                    // Parallel operations for storing order and refreshing auth
                    await Promise.all([
                        storeOrder(result.orderId, {
                            ...orderDetails,
                            timestamp: Date.now(),
                            status: result.status,
                            response: result.data,
                            executionType: orderDetails.type,
                            originalRequest: text
                        }),
                        debouncedAuthRefresh(config, account)
                    ]);

                    return {
                        success: true,
                        message: JSON.stringify({
                            text: `${orderDetails.type} order opened successfully:\n` +
                                `• Order ID: ${result.orderId}\n` +
                                `• ${side.toUpperCase()} ${adjustedSize} ${baseToken}\n` +
                                (orderDetails.type === 'LIMIT' ? `• Price: ${orderDetails.price}\n` : '') +
                                `• Status: ${result.status}`
                        })
                    };
                } catch (error) {
                    console.error('Order execution error:', error);
                    throw error;
                }
            } catch (error) {
                return {
                    success: false,
                    message: JSON.stringify({
                        error: error instanceof Error ? error.message : String(error)
                    })
                };
            }
        }
    });

    const cancelOrderAction = action({
        name: "paradex-cancel-order",
        description: "Cancel an existing order. You can say something like 'cancel order 123' or 'remove order ABC'",
        schema: z.object({
            text: z.string().describe("Natural language request to cancel an order")
        }),
        handler: async (call, _ctx, _agent) => {
            try {
                const text = call.data.text.toLowerCase();
                const orderIdMatch = text.match(/(?:order|#)\s*([a-zA-Z0-9]+)/);

                if (!orderIdMatch) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: "Please specify the order ID. For example: 'cancel order 123'"
                        })
                    };
                }

                const orderId = orderIdMatch[1];
                await cancelOrder(config, account, orderId);
                return {
                    success: true,
                    message: JSON.stringify({
                        text: `Order ${orderId} has been canceled successfully`
                    })
                };
            } catch (error) {
                return {
                    success: false,
                    message: JSON.stringify({
                        text: error instanceof Error ? error.message : String(error)
                    })
                };
            }
        },
    });

    const listOpenOrdersAction = action({
        name: "paradex-list-open-orders",
        description: "Show your current open orders",
        schema: z.object({
            text: z.string().describe("Natural language request to view open orders")
        }),
        handler: async (_call, _ctx, _agent) => {
            try {
                const orders = await getOpenOrders(config, account);
                return {
                    success: true,
                    message: JSON.stringify({
                        text: orders.length ?
                            `Your Open Orders:\n${orders.map((order: ParadexOrder) =>
                                `• ${order.market}: ${order.side} ${order.size} @ ${order.price} (${order.type})`).join('\n')}` :
                            "You don't have any open orders at the moment."
                    })
                };
            } catch (error) {
                return {
                    success: false,
                    message: JSON.stringify({ error: String(error) })
                };
            }
        }
    });

    const listAvailableMarketsAction = action({
        name: "paradex-list-available-markets",
        description: "Show available trading markets",
        schema: z.object({
            text: z.string().describe("Natural language request to view available markets")
        }),
        handler: async (_call, _ctx, _agent) => {
            try {
                const markets = await listAvailableMarkets(config);
                if (!markets || markets.length === 0) {
                    return {
                        success: true,
                        message: JSON.stringify({
                            text: "No trading markets are available at the moment."
                        })
                    };
                }

                const marketList = markets
                    .map((market: { symbol: string }) => market.symbol)
                    .join("\n• ");

                return {
                    success: true,
                    message: JSON.stringify({
                        text: `Available Trading Markets:\n• ${marketList}`
                    })
                };
            } catch (error) {
                return {
                    success: false,
                    message: JSON.stringify({
                        error: error instanceof Error ? error.message : String(error)
                    })
                };
            }
        }
    });

    const getPositionsAction = action({
        name: "paradex-get-positions",
        description: "Show your current trading positions",
        schema: z.object({
            text: z.string().describe("Natural language request to view positions")
        }),
        handler: async (_call, _ctx, _agent) => {
            try {
                const positions = await getPositions(config, account);
                return {
                    success: true,
                    message: JSON.stringify({
                        text: positions.length ?
                            `Current positions:\n${positions.map((p: { market: string; size: string; price: string }) =>
                                `${p.market}: ${p.size} @ ${p.price}`).join('\n')}` :
                            "No open positions"
                    })
                };
            } catch (error) {
                return {
                    success: false,
                    message: JSON.stringify({ error: String(error) })
                };
            }
        }
    });

    const getOrderHistoryAction = action({
        name: "paradex-get-order-history",
        description: "Retrieve details of a specific order by ID",
        schema: z.object({
            text: z.string().describe("Natural language request to get order details, including order ID")
        }),
        handler: async (call, _ctx, _agent) => {
            try {
                const text = call.data.text.toLowerCase();
                const orderIdMatch = text.match(/(?:order|#)\s*([a-zA-Z0-9]+)/);

                if (!orderIdMatch) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: "Please specify the order ID. For example: 'show order 123'"
                        })
                    };
                }

                const orderId = orderIdMatch[1];
                const orderDetails = await getOrder(orderId);

                if (!orderDetails) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: `No history found for order ${orderId}`
                        })
                    };
                }

                return {
                    success: true,
                    message: JSON.stringify({
                        text: `Order ${orderId} details:\n${JSON.stringify(orderDetails, null, 2)}`
                    })
                };
            } catch (error) {
                return {
                    success: false,
                    message: JSON.stringify({
                        error: error instanceof Error ? error.message : String(error)
                    })
                };
            }
        }
    });

    const agent = createDreams({
        model: groq("llama-3.3-70b-versatile"),
        memory: {
            store: createMemoryStore(),
            vector: createVectorStore(),
        },
        extensions: [cli],
        actions: [
            ...[getAccountInfoAction, openOrderAction, cancelOrderAction,
                listOpenOrdersAction, listAvailableMarketsAction,
                getPositionsAction, getOrderHistoryAction].map(originalAction => ({
                    ...originalAction,
                    handler: async (call: any, ctx: any, agent: any) => {
                        if (!rateLimiter.canMakeRequest()) {
                            return {
                                success: false,
                                message: JSON.stringify({
                                    text: "Rate limit reached. Please wait a moment before trying again."
                                })
                            };
                        }
                        rateLimiter.trackRequest();
                        return originalAction.handler(call, ctx, agent);
                    }
                })) as Action<any, any, any, any, any>[]
        ],
    }).start();

    return agent;
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
