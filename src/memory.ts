import { createMemoryStore, createVectorStore } from "@daydreamsai/core";

export const orderStore = createMemoryStore();
export const orderVectorStore = createVectorStore();

// Store order history
export async function storeOrder(orderId: string, orderData: any) {
    await orderStore.set(orderId, orderData);
    await orderVectorStore.upsert(orderId, [orderData]);
}

// Retrieve order history
export async function getOrder(orderId: string) {
    return await orderStore.get(orderId);
} 