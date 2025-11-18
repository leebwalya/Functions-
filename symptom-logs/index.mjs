// Import the DynamoDB client from AWS SDK
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
// Import helper functions to work with DynamoDB in a simpler way
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

// NEW: Import SQS client to send messages to the queue (asynchronous writes)
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

// Create a new DynamoDB client
const client = new DynamoDBClient({});
// Create a document client from the regular client 
const dynamo = DynamoDBDocumentClient.from(client);
// Set the name of the table
const tableName = process.env.SYMPTOM_TABLE;

//  NEW: Create an SQS client and read the queue URL from env vars
const sqs = new SQSClient({});
const symptomLogQueueUrl = process.env.SYMPTOM_LOG_QUEUE_URL;

// Main function that runs when the Lambda is triggered
export const handler = async (event) => {
   // Print the incoming request for debugging
  console.log("Incoming event:", JSON.stringify(event));

    // Set default status code and response body
  let statusCode = 200;
  let body;

  // Set headers to allow requests from any website (CORS)
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,DELETE",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Content-Type": "application/json",
  };

  try {
    //  Handle CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: "CORS preflight OK" }),
      };
    }

    // Extract and verify token 
    const userId = event.requestContext?.authorizer?.claims?.sub;
    if (!userId) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Missing user ID in authorizer claims" }),
      };
    }

    switch (event.httpMethod) {
      //  POST - Add a new symptom
      case "POST": {
        const data = JSON.parse(event.body);

        //  CHANGED: Instead of writing directly to DynamoDB here,
        // we enqueue the payload to SQS for asynchronous, reliable processing.
        // This protects the system under heavy concurrent loads.
        if (!symptomLogQueueUrl) {
          throw new Error("SYMPTOM_LOG_QUEUE_URL env var not set");
        }

        // Keep your simple id approach for traceability
        const id = `id-${Date.now()}`;

        // Build the message we will send to SQS (include userId, id, and original fields)
        const message = {
          UserId: userId,
          id,
          ...data,
          createdAt: new Date().toISOString(),
        };

        // Send to the queue
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: symptomLogQueueUrl,
            MessageBody: JSON.stringify(message),
          })
        );

        // Return 202 to indicate it was accepted and queued (asynchronous processing)
        statusCode = 202;
        // Set the response message
        body = { message: "Symptom entry queued", id };
        break;
      }

      //  GET - Fetch only this user's logs
      case "GET": {
        const queryResult = await dynamo.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "UserId = :uid", 
            ExpressionAttributeValues: { ":uid": userId },
          })
        );
        body = queryResult.Items || [];
        break;
      }

      // DELETE - Remove one log by ID
      case "DELETE": {
        const deleteId = event.pathParameters?.id;
        if (!deleteId) throw new Error("Missing ID for deletion");

        await dynamo.send(
          new DeleteCommand({
            TableName: tableName,
            Key: { UserId: userId, id: deleteId },
          })
        );
         // Set the response message
        body = { message:   `Deleted log ${deleteId} `};
        break;
      }

       // If the method is not one of the above, return an error
      default: {
        statusCode = 405;
        body = { error: "Method not allowed" };
        break;
      }
    }
  } catch (err) {
     // If something goes wrong, log the error and return a 500
    console.error("Lambda Error:", err);
    statusCode = 500;
    body = { error: err.message || "Internal server error" };
  }

 // Return the final response
  return {
    isBase64Encoded: false,
    statusCode,
    headers,
    body: JSON.stringify(body),
  };
};
