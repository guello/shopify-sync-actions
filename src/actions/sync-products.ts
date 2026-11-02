import sheets, { hyperlink } from '@@/google/sheets'
import shopify, {
  InventoryItem,
  LOCATION_ID,
  Product as ProductBase,
  ProductVariant,
  adminDomain,
  isThrottled,
} from '@@/shopify'
import { AdjustQuantitiesInput } from '@@/shopify/inventory/update'
import pim from '@@/pim'

import { Action, ActionPayload, ActionStatus } from '@/types'
import { logger, pluralize, toID } from '@/utils'

const BASE_INPUT = {
  reason: 'correction',
  name: 'available',
}

const inventoryLevelFields = (locationId: string) => `
  inventoryItem {
    inventoryLevel(locationId: "${locationId}") {
      quantities(names: ["${BASE_INPUT.name}"]) {
        quantity
      }
    }
  }`

interface Product extends ProductBase {
  onlineStoreUrl: string
  seo: {
    title: string
  }
}

interface Variant extends ProductVariant {
  sku: string
  displayName: string
  product: Product
  inventoryQuantity: number
  inventoryItem: InventoryItem & {
    inventoryLevel?: { quantities: { quantity: number }[] } | null
  }
}

interface VariantChange {
  date?: string
  variant: Variant
  quantities: number[]
  delta: number
}

const productUrl = (product: Product): string => `https://${adminDomain}/products/${toID(product.id)}`
const productHyperlink = (product: Product) => hyperlink(productUrl(product), product.title)
const variantUrl = (variant: Variant): string => `${productUrl(variant.product)}/variants/${toID(variant.id)}`
const variantName = (variant: Variant): string => variant.displayName.replace(`${variant.product.title} - `, '')
const variantHyperlink = (variant: Variant) => hyperlink(variantUrl(variant), variantName(variant))
const websiteUrl = (variant: Variant): string => `${variant.product.onlineStoreUrl}?variant=${toID(variant.id)}`
const websiteName = (variant: Variant, shopName?: string): string =>
  `${variant.product.title}${shopName ? ` - ${shopName}` : ''}`
const websiteHyperlink = (variant: Variant, shopName?: string): string =>
  hyperlink(websiteUrl(variant), websiteName(variant, shopName))

/**
 * Synchronizes product quantities between the PIM and Shopify.
 */
export const syncProducts: Action = async ({ event, retries, runId }) => {
  let updatesCount = 0

  for (const i of Array(retries).keys()) {
    const variantChanges: VariantChange[] = []
    const isLastRetry = i === retries - 1

    const baseLog: ActionPayload = { event, runId }

    const shop = await shopify.fetchShop()

    const location = await shopify.fetchPrimaryLocation()
    const locationId = location?.id || LOCATION_ID

    const { data } = await shopify.fetchAllProductVariants<Variant>()
    const variants = data?.productVariants?.edges || []

    if (!variants.length) {
      await sheets.logProducts({
        ...baseLog,
        status: ActionStatus.failed,
        message: 'No product variants found',
      })
      if (isLastRetry) throw new Error('No product variants found after retries')
      continue
    }

    const items = variants.map(({ sku }) => ({ variantId: sku }))
    const availabilities = await pim.verifyAvailability({ items })

    const updates = availabilities.reduce(
      (changes, { variantId, actualAvailability }) => {
        const variant = variants.find(({ sku }) => sku === variantId)

        if (!variant) return changes

        const { inventoryItem, inventoryQuantity } = variant
        const isDuplicate = changes.some(({ inventoryItemId }) => inventoryItemId === inventoryItem.id)

        if (inventoryQuantity === actualAvailability || inventoryQuantity < 1 || actualAvailability > 0 || isDuplicate)
          return changes

        const quantities = [inventoryQuantity, actualAvailability]
        const delta = actualAvailability - inventoryQuantity

        variantChanges.push({ variant, quantities, delta })

        return [...changes, { delta, inventoryItemId: inventoryItem.id, locationId }]
      },
      [] as Omit<AdjustQuantitiesInput['changes'][number], 'changeFromQuantity'>[]
    )

    if (!updates.length) break

    const { data: changedData, errors: changedErrors } = await shopify.fetchProductVariants<Variant>({
      ids: variantChanges.map(({ variant }) => variant.id),
      fields: inventoryLevelFields(locationId),
    })
    if (changedErrors || !changedData?.productVariants) throw new Error('Could not verify product variants')
    const changedVariants = changedData?.productVariants?.edges || []

    const changes = updates.flatMap(update => {
      const variantChange = variantChanges.find(({ variant }) => variant.inventoryItem.id === update.inventoryItemId)
      const changedVariant = changedVariants.find(({ node }) => node.inventoryItem.id === update.inventoryItemId)?.node
      const changeFromQuantity = changedVariant?.inventoryItem.inventoryLevel?.quantities[0]?.quantity
      if (changeFromQuantity === undefined || variantChange?.quantities[0] !== changedVariant?.inventoryQuantity)
        return []
      return [{ ...update, changeFromQuantity }]
    })

    const skipped = updates.length - changes.length
    if (skipped)
      logger.warning(
        `Skipped ${skipped} ${pluralize('variant', skipped)} changed during sync or not stocked at the location`
      )
    if (!changes.length) break

    const input = { ...BASE_INPUT, changes }
    const { data: adjustData, errors } = await shopify.adjustQuantities({
      input,
    })

    if (
      !adjustData?.inventoryAdjustQuantities?.inventoryAdjustmentGroup ||
      errors ||
      adjustData.inventoryAdjustQuantities.userErrors?.length
    ) {
      if (!errors || !isThrottled(errors)) {
        await sheets.logProducts({
          ...baseLog,
          status: ActionStatus.failed,
          errors: errors || adjustData?.inventoryAdjustQuantities?.userErrors,
          message: 'Shopify API error',
        })
      }
      if (isLastRetry) throw new Error('Shopify API error after retries')
      continue
    }

    const { changes: inventoryChanges = [] } = adjustData.inventoryAdjustQuantities?.inventoryAdjustmentGroup || {}

    for (const change of inventoryChanges) {
      if (change.name !== BASE_INPUT.name) continue

      const variantChange = variantChanges.find(({ variant }) => variant.inventoryItem.id === change.item.id)
      if (!variantChange) continue

      logger.info(`✓ [${variantChange.variant.sku}] ${variantChange.quantities.join(' → ')}`)
      await sheets.logProducts({
        ...baseLog,
        status: ActionStatus.success,
        product: productHyperlink(variantChange.variant.product),
        variant: variantHyperlink(variantChange.variant),
        website: websiteHyperlink(variantChange.variant, shop.name),
        previous: variantChange.quantities[0],
        new: variantChange.quantities[1],
        delta: change.delta,
      })
      updatesCount++
    }
    break
  }

  logger.notice(
    updatesCount ? `\nAdjusted quantity of ${updatesCount} product ${pluralize('variant', updatesCount)}` : 'No changes'
  )
}
