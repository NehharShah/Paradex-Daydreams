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
import { z } from "zod";
interface ParadexOrder {
    market: string;
    side: string;
    type: string;
    size: string;
    price: string;
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

async function main() {
    const { config, account } = await paradexLogin();
    const refreshInterval = setInterval(async () => {
        account.jwtToken = await authenticate(config, account);
    }, 1000 * 60 * 3 - 3000); // refresh every ~3 minutes
    process.on("SIGTERM", () => {
        clearInterval(refreshInterval);
        process.exit(0);
    });

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
        description: "Open a new order on Paradex. You can describe your order in natural language, like 'buy 0.1 ETH at 3000 dollars' or 'sell 0.5 BTC at market price'.",
        schema: z.object({
            text: z.string().describe("Natural language description of the order you want to place")
        }),
        handler: async (call, _ctx, _agent) => {
            try {
                const availableMarkets = await listAvailableMarkets(config);
                const text = call.data.text.toLowerCase();

                // First look for the token/market name
                const tokenMatch = text.match(/\b(?:buy|sell)\s+\d+\.?\d*\s+([a-zA-Z0-9]+)\b/i);
                if (!tokenMatch) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: "Please specify which token you want to trade"
                        })
                    };
                }

                const baseToken = tokenMatch[1].toUpperCase();
                const marketSymbol = `${baseToken}-USD-PERP`;

                console.log("Detected token:", baseToken);
                console.log("Constructed market symbol:", marketSymbol);

                const marketExists = availableMarkets.some((m: { symbol: string }) => m.symbol === marketSymbol);

                if (!marketExists) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: `Market ${marketSymbol} is not available. Please check the available markets list.`
                        })
                    };
                }

                const market = availableMarkets.find((m: { symbol: string }) => m.symbol === marketSymbol);
                if (!market) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: `Market ${marketSymbol} is not available`
                        })
                    };
                }

                const sideMatch = text.match(/\b(buy|sell)\b/);
                const sizeMatch = text.match(/\b(\d+\.?\d*)\b/);

                if (!sideMatch || !sizeMatch) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: "Please specify the side (buy/sell) and size. For example: 'buy 0.1 LINK at market price'"
                        })
                    };
                }

                const size = sizeMatch ? Math.max(
                    Number(market.order_size_increment),
                    Math.ceil(Number(sizeMatch[1]) / Number(market.order_size_increment)) * Number(market.order_size_increment)
                ).toString() : null;

                if (!size) {
                    return {
                        success: false,
                        message: JSON.stringify({
                            text: "Invalid order size"
                        })
                    };
                }

                const orderDetails = {
                    market: marketSymbol,
                    side: sideMatch[1].toUpperCase(),
                    type: "MARKET",
                    size,
                    timeInForceType: "IOC"
                };

                console.log("Interpreted order:", orderDetails);

                try {
                    const result = await openOrder(config, account, orderDetails);
                    console.log("Order response:", result);
                    return {
                        success: true,
                        message: JSON.stringify({
                            text: `Order opened successfully. Order ID: ${result.orderId}`
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
            } catch (error) {
                console.error('Error processing order:', error);
                return {
                    success: false,
                    message: JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
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

    const agent = createDreams({
        model: groq("deepseek-r1-distill-llama-70b"),
        memory: {
            store: createMemoryStore(),
            vector: createVectorStore(),
        },
        extensions: [cli],
        actions: [
            getAccountInfoAction,
            openOrderAction,
            cancelOrderAction,
            listOpenOrdersAction,
            listAvailableMarketsAction,
            getPositionsAction,
        ]
    }).start();

    return agent;
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
