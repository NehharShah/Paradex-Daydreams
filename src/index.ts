import { shortString } from "starknet";
import type { ParadexAccount, ParadexConfig } from "./types";
import {
    authenticate,
    getAccountInfo,
    getOpenOrders,
    getPositions,
    listAvailableMarkets,
    openOrder,
} from "./paradex";
import { env } from "./config";
import { anthropic } from "@ai-sdk/anthropic";
import {
    action,
    cli,
    createDreams,
    createMemoryStore,
    createVectorStore,
} from "@daydreamsai/core/v1";
import { z } from "zod";

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
        description:
            "Create an order on Paradex. The action requires which market to open the order on, the price and size (as strings), the side (either BUY or SELL) and a type of order (MARKET or LIMIT).",
        schema: z.object({
            instruction: z.literal("GTC").describe(
                "Order instruction, Good Till Cancelled",
            ),
            market: z.string().describe(
                "Market for which the order is created",
            ),
            price: z.string().describe("Order price"),
            size: z.string().describe("Size of the order"),
            side: z.enum(["BUY", "SELL"]).describe("Order side"),
            type: z.enum(["MARKET", "LIMIT"]).describe("Order type"),
        }),
        handler: async (call, _ctx, _agent) => {
            const response = await openOrder(config, account, call.data);
            return response;
        },
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
        description:
            "Fetch a list of all open orders. No inputs are necessary.",
        schema: z.object({}),
        handler: async (_call, _ctx, _agent) => {
            const response = await getOpenOrders(config, account);
            return response;
        },
    });

    const listAvailableMarketsAction = action({
        name: "paradex-list-available-markets",
        description:
            "Fetch a list of all available markets. No inputs are necessary.",
        schema: z.object({}),
        handler: async (_call, _ctx, _agent) => {
            const response = await listAvailableMarkets(config);
            let markets: string[] = [];
            for (const market of response) {
                markets.push(market.symbol);
            }
            return markets;
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
        model: anthropic("claude-3-5-sonnet-20240620"),
        //model: openai("gpt-3.5-turbo"),
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
        ],
    }).start();
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
