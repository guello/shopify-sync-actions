import { randomUUID } from 'node:crypto'

import { client } from '@/clients/shopify'

import type { InventoryItem, Location } from '@/clients/shopify'

export interface AdjustQuantitiesInput {
  reason: string
  name: string
  changes: {
    changeFromQuantity: number | null
    delta: number
    inventoryItemId: InventoryItem['id']
    locationId: Location['id']
  }[]
}

/**
 * Request options for updating inventory quantities using the Shopify Admin API.
 */
export interface AdjustQuantitiesRequestOptions {
  input: AdjustQuantitiesInput
}

/**
 * Response after updating inventory quantities using the Shopify Admin API.
 */
export interface AdjustQuantitiesResponse {
  inventoryAdjustQuantities: {
    userErrors: { field: string[]; message: string }[]
    inventoryAdjustmentGroup: {
      createdAt: string
      reason: string
      changes: {
        name: string
        delta: number
        quantityAfterChange: number
        item: {
          id: string
        }
      }[]
    }
  }
}

const operation = `
  mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!, $idempotencyKey: String!) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors {
        field
        message
      }
      inventoryAdjustmentGroup {
        createdAt
        reason
        changes {
          name
          delta
          quantityAfterChange
          item {
            id
          }
        }
      }
    }
  }
`

/**
 * Adjusts inventory quantities. API version 2026-04 requires an idempotency key and a `changeFromQuantity` per change.
 * @see https://shopify.dev/docs/api/admin-graphql/2026-04/mutations/inventoryAdjustQuantities
 */
export const adjustQuantities = async ({ input }: AdjustQuantitiesRequestOptions) =>
  await client.request<AdjustQuantitiesResponse>(operation, {
    variables: { input, idempotencyKey: randomUUID() },
  })
