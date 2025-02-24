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

interface AuthRequest extends Record<string, unknown> {
    method: string;
    path: string;
    body: string;
    timestamp: number;
    expiration: number;
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
    };

    try {
        const response = await fetch(`${config.apiBaseUrl}/auth`, {
            method: "POST",
            headers,
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data.jwt_token;
    } catch (e) {
        console.error(e);
    }
}

// https://docs.paradex.trade/api-reference/prod/account/get
export async function getAccountInfo(config: ParadexConfig, account: ParadexAccount) {
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
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data;
    } catch (e) {
        console.error(e);
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

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        return data;
    } catch (e) {
        console.error(e);
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