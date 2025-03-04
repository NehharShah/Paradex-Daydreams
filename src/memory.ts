import { createMemoryStore, createVectorStore } from "@daydreamsai/core";

export const orderStore = createMemoryStore();
export const orderVectorStore = createVectorStore();

interface OrderData {
    market: string;
    side: 'BUY' | 'SELL';
    type: 'MARKET' | 'LIMIT';
    size: string;
    price?: string;
    timestamp: number;
    status: string;
    response: any;
    executionType: string;
    originalRequest: string;
}

// Store order history
export async function storeOrder(orderId: string, orderData: OrderData) {
    await orderStore.set(orderId, orderData);
    await orderVectorStore.upsert(orderId, [orderData]);
}

// Retrieve order history
export async function getOrder(orderId: string): Promise<OrderData | null> {
    return await orderStore.get(orderId);
} 