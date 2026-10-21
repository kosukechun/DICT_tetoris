import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

// Identical key-value contract for local JSON and production DynamoDB.
export async function createStore({ directory = 'data', table = process.env.DYNAMODB_TABLE } = {}) {
  if (table) {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } =
      await import('@aws-sdk/lib-dynamodb');
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    return {
      async get(pk, sk) {
        return (
          await client.send(
            new GetCommand({ TableName: table, Key: { pk, sk }, ConsistentRead: true })
          )
        ).Item;
      },
      async put(item, unique = false) {
        try {
          await client.send(
            new PutCommand({
              TableName: table,
              Item: item,
              ...(unique ? { ConditionExpression: 'attribute_not_exists(pk)' } : {})
            })
          );
          return true;
        } catch (error) {
          if (error.name === 'ConditionalCheckFailedException') return false;
          throw error;
        }
      },
      async remove(pk, sk) {
        await client.send(new DeleteCommand({ TableName: table, Key: { pk, sk } }));
      },
      async list(pk, prefix, limit = 20) {
        const items = [];
        let exclusiveStartKey;
        do {
          const remaining = limit === null ? undefined : limit - items.length;
          const response = await client.send(
            new QueryCommand({
              TableName: table,
              KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
              ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix },
              ScanIndexForward: false,
              ...(remaining === undefined ? {} : { Limit: remaining }),
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
              ConsistentRead: true
            })
          );
          items.push(...(response.Items || []));
          exclusiveStartKey = response.LastEvaluatedKey;
        } while (exclusiveStartKey && (limit === null || items.length < limit));
        return items;
      }
    };
  }
  await mkdir(directory, { recursive: true });
  const filename = path.resolve(directory, 'database.json');
  let rows = {};
  try {
    rows = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let pending = Promise.resolve();
  function mutate(callback) {
    const result = pending.then(async () => {
      const copy = structuredClone(rows),
        value = callback(copy);
      await writeFile(filename + '.tmp', JSON.stringify(copy), { mode: 0o600 });
      await rename(filename + '.tmp', filename);
      rows = copy;
      return value;
    });
    pending = result.catch(() => {});
    return result;
  }
  const key = (pk, sk) => JSON.stringify([pk, sk]);
  return {
    async get(pk, sk) {
      await pending;
      return structuredClone(rows[key(pk, sk)]);
    },
    put(item, unique = false) {
      return mutate((copy) => {
        const k = key(item.pk, item.sk);
        if (unique && copy[k]) return false;
        copy[k] = item;
        return true;
      });
    },
    remove(pk, sk) {
      return mutate((copy) => {
        delete copy[key(pk, sk)];
      });
    },
    async list(pk, prefix, limit = 20) {
      await pending;
      const matches = Object.values(rows)
        .filter((row) => row.pk === pk && row.sk.startsWith(prefix))
        .sort((a, b) => b.sk.localeCompare(a.sk));
      return (limit === null ? matches : matches.slice(0, limit)).map((row) =>
        structuredClone(row)
      );
    }
  };
}
