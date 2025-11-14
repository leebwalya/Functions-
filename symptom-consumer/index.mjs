import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.SYMPTOM_TABLE;

export const handler = async (event) => {
  for (const record of event.Records) {
    try {
      const item = JSON.parse(record.body);
      await ddb.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
        })
      );
      console.log("Saved:", item.id);
    } catch (err) {
      console.error("Failed:", err);
    }
  }
};
