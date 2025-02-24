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
//import { anthropic } from "@ai-sdk/anthropic";
import { groq } from "@ai-sdk/groq";
import {
    action,
    cli,
    createDreams,
    createMemoryStore,
    createVectorStore,
} from "@daydreamsai/core/v1";
import { z } from "zod";

interface Market {
    symbol: string;
    // Add other market properties if needed
}

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
    const apiBaseUrl = env.PARADEX_BASE_URL;
    const chainId = shortString.encodeShortString(env.PARADEX_CHAIN_ID);
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
        description:
            "Get account information. No inputs are necessary. Returns the account value, free collateral and other details about the trading account.",
        schema: z.object({}),
        handler: async (_call, _ctx, _agent) => {
            const accountInfo = await getAccountInfo(config, account);
            return accountInfo;
        },
    });

    const openOrderAction = action({
        name: "paradex-open-order",
        description: "Open a new order on Paradex",
        schema: z.object({
            text: z.string().describe("Command text")
        }),
        handler: async (call, _ctx, _agent) => {
            try {
                const parts = call.data.text.split(' ');
                const startIndex = parts[0] === 'paradex-open-order' ? 1 : 0;
                
                if (parts.length < startIndex + 5) {
                    return { 
                        success: false, 
                        message: "Usage: paradex-open-order <market> <side> <type> <size> <price>"
                    };
                }

                const orderDetails = {
                    market: parts[startIndex],
                    side: parts[startIndex + 1],
                    type: parts[startIndex + 2],
                    size: parts[startIndex + 3],
                    price: parts[startIndex + 4],
                    timeInForceType: "GTC"
                };
                
                console.log("Sending order:", orderDetails);
                const result = await openOrder(config, account, orderDetails);
                return { 
                    success: true, 
                    message: `Order opened successfully. Transaction hash: ${result.transactionHash}`
                };
            } catch (error) {
                console.error('Error opening order:', error);
                return { success: false, message: `Error: ${error instanceof Error ? error.message : String(error)}` };
            }
        }
    });

    const cancelOrderAction = action({
        name: "paradex-cancel-order",
        description:
            "Cancel an order on Paradex. The action requires the order ID.",
        schema: z.object({ orderId: z.string().describe("Order ID") }),
        handler: async (call, _ctx, _agent) => {
            const _response = await cancelOrder(
                config,
                account,
                call.data.orderId,
            );
            return "Order canceled";
        },
    });

    const listOpenOrdersAction = action({
        name: "paradex-list-open-orders",
        description: "List all open orders on Paradex",
        schema: z.object({
            text: z.string()
        }),
        handler: async (_call, _ctx, _agent) => {
            try {
                const orders = await getOpenOrders(config, account);
                if (!orders || orders.length === 0) {
                    return {
                        success: true,
                        message: { text: "No open orders found" }
                    };
                }

                const orderList = orders.map((order: ParadexOrder) => 
                    `${order.market} ${order.side} ${order.type} Size: ${order.size} Price: ${order.price}`
                ).join('\n');

                return {
                    success: true,
                    message: { text: `Open Orders:\n${orderList}` }
                };
            } catch (error) {
                console.error('Error listing orders:', error);
                return {
                    success: false,
                    message: { text: `Error: ${error instanceof Error ? error.message : String(error)}` }
                };
            }
        }
    });

    const listAvailableMarketsAction = action({
        name: "paradex-list-available-markets",
        description: "Fetch a list of all available markets. No inputs are necessary.",
        schema: z.object({}),
        handler: async (_call, _ctx, _agent) => {
            try {
                const markets = await listAvailableMarkets(config);
                if (!markets || markets.length === 0) {
                    return { markets: "No markets available" };
                }
                const marketList = markets.map((market: { symbol: string }) => market.symbol).join(", ");
                return { markets: marketList };
            } catch (error) {
                console.error('Error fetching markets:', error);
                return { markets: "Error fetching markets", error: String(error) };
            }
        },
    });

    const getPositionsAction = action({
        name: "paradex-get-positions",
        description:
            "Fetch a list of all open positions. No inputs are necessary.",
        schema: z.object({}),
        handler: async (_call, _ctx, _agent) => {
            const response = await getPositions(config, account);
            return response;
        },
    });

    const agent = createDreams({
        model: groq("llama3-8b-8192"),
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
