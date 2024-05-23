import { gte, inArray, lte } from "drizzle-orm"
import { EpochActivity, Range, ValidatorActivity } from "../vts/types"
// @ts-expect-error no types
import Identicons from '@nimiq/identicons'
import { NewScore, NewValidator } from "../utils/drizzle"

export async function getMissingValidators(addresses: string[]) {
  const existingAddresses = await useDrizzle()
    .select({ address: tables.validators.address })
    .from(tables.validators)
    .where(inArray(tables.validators.address, addresses))
    .execute().then(r => r.map(r => r.address))

  const missingAddresses = addresses.filter(a => existingAddresses.indexOf(a) === -1)
  return missingAddresses
}

// A simple cache to avoid querying the database multiple times for the same validator
// Useful when we are fetching batches of activities for the same validator across multiple epochs
const validators = new Map<string, number>()

export async function storeValidator(address: string, rest: Omit<NewValidator, 'address' | 'icon'> = {}) {
  if (validators.has(address)) return validators.get(address) as number
  const validatorId = await useDrizzle()
    .select({ id: tables.validators.id })
    .from(tables.validators)
    .where(eq(tables.validators.address, address))
    .get().then(r => r?.id)

  if (validatorId) {
    validators.set(address, validatorId)
    return validatorId
  }

  const icon = await Identicons.default.toDataUrl(address) as string
  const newValidator = await useDrizzle().insert(tables.validators).values({ address, icon, ...rest }).returning().get()
  validators.set(address, newValidator.id)
  return newValidator.id
}

/**
 * Give a list of validator addresses and a range of epochs, it returns the activity for the given validators and epochs.
 * If there are missing validators or epochs, it will throw an error.
 */
export async function getActivityByValidator(validators: { address: string, balance: number }[], range: Range) {
  const addresses = validators.map(v => v.address)
  const missingValidators = await getMissingValidators(addresses)
  if (missingValidators.length > 0) throw new Error(`Missing validators: ${missingValidators.join(', ')}`)

  const missingEpochs = await getMissingEpochs(range)
  if (missingEpochs.length > 0) throw new Error(`Missing epochs: ${missingEpochs.join(', ')}`)

  const activities = await useDrizzle()
    .select({
      blockNumber: tables.activity.epochBlockNumber,
      address: tables.validators.address,
      validatorId: tables.validators.id
    })
    .from(tables.activity)
    .innerJoin(tables.validators, eq(tables.activity.validatorId, tables.validators.id))
    .where(and(
      lte(tables.activity.epochBlockNumber, range.toEpoch), gte(tables.activity.epochBlockNumber, range.fromEpoch),
      inArray(tables.validators.address, addresses)
    ))
    .execute()

  const activitiesByValidator = activities.reduce((acc, activity) => {
    const balance = validators.find(v => v.address === activity.address)?.balance
    if (!balance) throw new Error(`No balance for validator ${activity.address}`)
    if (!acc[activity.address]) acc[activity.address] = { validatorId: activity.validatorId, balance, activeEpochBlockNumbers: [] }
    acc[activity.address].activeEpochBlockNumbers.push(activity.blockNumber)
    return acc
  }, {} as ValidatorActivity)
  return activitiesByValidator
}

/**
 * Given a range of epochs, it returns the epochs that are missing in the database. 
 */
export async function getMissingEpochs(range: Range) {
  const existingEpochs = await useDrizzle()
    .select({ epochBlockNumber: tables.activity.epochBlockNumber })
    .from(tables.activity)
    .where(and(gte(tables.activity.epochBlockNumber, range.fromEpoch), lte(tables.activity.epochBlockNumber, range.toEpoch)))
    .execute().then(r => r.map(r => r.epochBlockNumber))

  const missingEpochs = []
  for (let i = range.fromEpoch; i <= range.toEpoch; i += range.blocksPerEpoch) {
    if (existingEpochs.indexOf(i) === -1) missingEpochs.push(i)
  }
  return missingEpochs
}

/**
 * It computes the score for a given range of epochs. It will fetch the activity for the given epochs and then compute the score for each validator. 
 * It will delete the activities for the given epochs and then insert the new activities.
 */
export async function storeActivities(activities: EpochActivity) {

  const values: Newactivity[] = []
  const blockNumbers = Object.keys(activities).map(Number)
  for (const _epochBlockNumber of blockNumbers) {
    const epochBlockNumber = Number(_epochBlockNumber)
    for (const { assigned, missed, validator } of activities[epochBlockNumber]) {
      const validatorId = await storeValidator(validator)
      values.push({ assigned, missed, epochBlockNumber, validatorId })
    }
  }

  await useDrizzle().delete(tables.activity).where(inArray(tables.activity.epochBlockNumber, blockNumbers))

  // For some reason, D1 is hanging when inserting all the values at once. So dividing the values in chunks of 32
  // seems to work: https://github.com/prisma/prisma/discussions/23646#discussioncomment-9083299
  const chunkArray = (arr: any[], chunkSize: number) => Array.from({ length: Math.ceil(arr.length / chunkSize) }, (_, i) => arr.slice(i * chunkSize, i * chunkSize + chunkSize))
  for (const chunk of chunkArray(values, 16))
    await useDrizzle().insert(tables.activity).values(chunk)


  // If we ever move out of cloudfare we could use transactions to avoid inconsistencies and improve performance
  // Cloudfare D1 does not support transactions: https://github.com/cloudflare/workerd/blob/e78561270004797ff008f17790dae7cfe4a39629/src/workerd/api/sql-test.js#L252-L253
  // await useDrizzle().transaction(async (tx) => {
  //  await tx.delete(tables.activity).where(inArray(tables.activity.epochBlockNumbers, blockNumbers))
  //  await Promise.all(values.map(v => tx.insert(tables.activity).values(v)))
  // })
}

/**
 * Insert the scores into the database. To avoid inconsistencies, it deletes all the scores for the given validators and then inserts the new scores.
 */
export async function storeScores(scores: NewScore[]) {
  await useDrizzle().delete(tables.scores).where(or(...scores.map(({ validatorId }) => eq(tables.scores.validatorId, validatorId))))
  await useDrizzle().insert(tables.scores).values(scores)

  // If we ever move out of cloudfare we could use transactions to avoid inconsistencies
  // Cloudfare D1 does not support transactions: https://github.com/cloudflare/workerd/blob/e78561270004797ff008f17790dae7cfe4a39629/src/workerd/api/sql-test.js#L252-L253
  // await useDrizzle().transaction(async (tx) => {
  //   await tx.delete(tables.scores).where(or(...scores.map(({ validatorId }) => eq(tables.scores.validatorId, validatorId))))
  //   await tx.insert(tables.scores).values(scores.map(s => ({ ...s, updatedAt })))
  // })
}
