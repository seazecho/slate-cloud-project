const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { QueueServiceClient } = require('@azure/storage-queue');
const { randomUUID } = require('crypto');

// -----------------------------------------------------------------------------
// Database & Storage Helper Clients
// -----------------------------------------------------------------------------
let cosmosDbInstance = null;

function getCosmosDatabase() {
  if (cosmosDbInstance) {
    return cosmosDbInstance;
  }

  const connectionString =
    process.env.COSMOS_CONNECTION_STRING || process.env.COSMOS_DB_CONNECTION_STRING;
  const endpoint = process.env.COSMOS_DB_ENDPOINT;
  const key = process.env.COSMOS_DB_KEY;

  let client;
  if (connectionString) {
    client = new CosmosClient(connectionString);
  } else if (endpoint && key) {
    client = new CosmosClient({ endpoint, key });
  } else {
    throw new Error(
      'Cosmos DB connection details missing. Set COSMOS_CONNECTION_STRING or COSMOS_DB_ENDPOINT & COSMOS_DB_KEY.'
    );
  }

  cosmosDbInstance = client.database('slate-db');
  return cosmosDbInstance;
}

function getQueueClient(queueName = 'activity-events') {
  const connectionString =
    process.env.STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;

  if (!connectionString) {
    throw new Error(
      'Storage connection string missing. Set STORAGE_CONNECTION_STRING or AzureWebJobsStorage.'
    );
  }

  const queueServiceClient = QueueServiceClient.fromConnectionString(connectionString);
  return queueServiceClient.getQueueClient(queueName);
}

// -----------------------------------------------------------------------------
// 1. searchFilms (HTTP GET)
// -----------------------------------------------------------------------------
app.http('searchFilms', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const query = request.query.get('query');

      if (!query || !query.trim()) {
        return {
          status: 400,
          jsonBody: {
            error: "Query parameter 'query' is required."
          }
        };
      }

      const apiKey = process.env.TMDB_API_KEY;
      if (!apiKey) {
        return {
          status: 500,
          jsonBody: {
            error: 'TMDB_API_KEY environment variable is not configured.'
          }
        };
      }

      const url = `https://api.themoviedb.org/3/search/movie?api_key=${encodeURIComponent(
        apiKey
      )}&query=${encodeURIComponent(query.trim())}&include_adult=false&language=en-US&page=1`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          status: response.status,
          jsonBody: {
            error: `TMDB API returned error (${response.status}): ${errorText}`
          }
        };
      }

      const data = await response.json();

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        },
        jsonBody: data
      };
    } catch (err) {
      context.error('Error executing searchFilms:', err);
      return {
        status: 500,
        jsonBody: {
          error: err.message || 'Internal server error while searching films.'
        }
      };
    }
  }
});

// -----------------------------------------------------------------------------
// 2. logFilm (HTTP POST)
// -----------------------------------------------------------------------------
app.http('logFilm', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      let body;
      try {
        body = await request.json();
      } catch {
        return {
          status: 400,
          jsonBody: {
            error: 'Invalid JSON payload in request body.'
          }
        };
      }

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return {
          status: 400,
          jsonBody: {
            error: 'Request body must be a valid JSON object.'
          }
        };
      }

      if (!body.userId) {
        return {
          status: 400,
          jsonBody: {
            error: "Field 'userId' is required (partition key for logs container)."
          }
        };
      }

      const logRecord = {
        id: body.id || randomUUID(),
        userId: body.userId,
        filmId: body.filmId || null,
        filmTitle: body.filmTitle || body.title || null,
        rating: body.rating !== undefined ? body.rating : null,
        review: body.review || null,
        loggedAt: body.loggedAt || new Date().toISOString(),
        ...body
      };

      // 1. Save log record into Cosmos DB 'logs' container
      const db = getCosmosDatabase();
      const logsContainer = db.container('logs');
      const { resource: createdLog } = await logsContainer.items.create(logRecord);

      // 2. Push event payload to 'activity-events' storage queue
      const queueClient = getQueueClient('activity-events');
      await queueClient.createIfNotExists();

      const eventPayload = {
        eventId: randomUUID(),
        eventType: 'FILM_LOGGED',
        userId: createdLog.userId,
        filmId: createdLog.filmId,
        filmTitle: createdLog.filmTitle,
        logId: createdLog.id,
        timestamp: new Date().toISOString()
      };

      // Azure Functions queue triggers expect base64-encoded queue messages
      const base64Message = Buffer.from(JSON.stringify(eventPayload)).toString('base64');
      await queueClient.sendMessage(base64Message);

      return {
        status: 201,
        headers: {
          'Content-Type': 'application/json'
        },
        jsonBody: {
          message: 'Film log saved and activity event queued successfully.',
          log: createdLog,
          event: eventPayload
        }
      };
    } catch (err) {
      context.error('Error executing logFilm:', err);
      return {
        status: 500,
        jsonBody: {
          error: err.message || 'Internal server error while logging film.'
        }
      };
    }
  }
});

// -----------------------------------------------------------------------------
// 3. feedWorker (Queue Trigger)
// -----------------------------------------------------------------------------
app.storageQueue('feedWorker', {
  queueName: 'activity-events',
  connection: 'AzureWebJobsStorage',
  handler: async (queueItem, context) => {
    try {
      context.log('feedWorker received item:', queueItem);

      let payload = queueItem;
      if (typeof queueItem === 'string') {
        try {
          payload = JSON.parse(queueItem);
        } catch {
          payload = { rawMessage: queueItem };
        }
      }

      // Partition key for feed container is '/ownerId'
      const ownerId = payload.userId || payload.ownerId || 'user-default';

      const dummyFeedEntry = {
        id: randomUUID(),
        ownerId: ownerId,
        activityType: payload.eventType || 'FILM_LOGGED',
        filmId: payload.filmId || 'sample-film-id',
        filmTitle: payload.filmTitle || 'Sample Movie Title',
        feedMessage: `User ${ownerId} logged a film: ${payload.filmTitle || 'Unknown Title'}`,
        sourceEventId: payload.eventId || null,
        createdAt: new Date().toISOString()
      };

      const db = getCosmosDatabase();
      const feedContainer = db.container('feed');
      const { resource: createdFeed } = await feedContainer.items.create(dummyFeedEntry);

      context.log(
        `Successfully generated feed entry ${createdFeed.id} for owner ${createdFeed.ownerId}`
      );
    } catch (err) {
      context.error('Error processing feedWorker queue item:', err);
      throw err; // Rethrow to ensure message retry / poison queue handling
    }
  }
});
