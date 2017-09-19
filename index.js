'use strict';
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
const pgp = require('pg-promise')({});
const squel = require('squel');

const BucketName = process.env.BUCKET_NAME;

exports.store_batch = (event, context, callback) => {
  var batchId = null;
  var err = null;
  if (typeof event.headers === 'undefined') {
    err = { error: "headers not found" };
  } else {
    batchId = event.headers['X-MessageSystems-Batch-ID'];
    if (typeof batchId === 'undefined') {
      err = { error: "batch id not found" };
    }
  }

  if (err !== null) {
    // to return client-visible messages, don't specify an error
    // log it out too so it hits cloudwatch
    console.log(err.error);
    callback(null, {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(err)
    });
    return;
  }

  var blen = event.body.length;
  var params = { Bucket: BucketName, Key: batchId, Body: event.body };

  s3.putObject(params).promise()
    .then((data) => {
      callback(null, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: "stored "+ blen +" bytes for batch "+ batchId
        })
      });
    })
    .catch((err) => {
      console.log(err, err.stack);
      callback(err);
    });
};

function send_error(err, callback) {
  callback(err.error, {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(err)
  });
}

const pgCfg = {
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE
};
const eventCols = [
  'event_id', 'timestamp', 'type', 'bounce_class', 'campaign_id', 'friendly_from', 'message_id',
  'reason', 'rcpt_to', 'subaccount_id', 'template_id', 'transmission_id', 'event'
];
const dupeBatchError = "duplicate key value violates unique constraint \"batches_pkey\"";

exports.process_batch = (event, context, callback) => {
  if (typeof event.Records === 'undefined') {
    send_error({ error: "event.Records not found" });
    return;
  } else if (event.Records.length !== 1) {
    send_error({ error: "expected 1 record, got ["+ event.Records.length +"]" });
    return;
  }

  var e = event.Records[0];
  if (e.eventSource !== "aws:s3") {
    send_error({ error: "unexpected event source ["+ e.eventSource +"]" });
    return;
  }

  const bucketName = e.s3.bucket.name;
  const objKey = e.s3.object.key;
  if (typeof bucketName === 'undefined') {
    send_error({ error: "no bucket name in event" });
    return;
  } else if (bucketName !== BucketName) {
    send_error({ error: "unexpected bucket name ["+ bucketName +"]" });
    return;
  } else if (typeof objKey === 'undefined') {
    send_error({ error: "no object key in event" });
    return;
  }

  const params = { Bucket: bucketName, Key: objKey };

  s3.getObject(params).promise().then((data) => {
    const dbh = pgp(pgCfg);
    dbh.tx((t) => {
      return t.none('INSERT INTO public.batches (batch_uuid) VALUES ($1::uuid)', [objKey])
      .then(() => {
        // Delay building this potentially large query string
        // until after we know this batch hasn't already been loaded.
        const colSet = pgp.helpers.ColumnSet(eventCols, {table: 'events'});
        const jsonString = data.Body.toString(); // buffer => string
        const json = JSON.parse(jsonString); // string => object
        // Build query params
        var values = [];
        // Iterate over the events in the batch
        for (var i = 0; i < json.length; i++) {
          // Drill down to the event data
          var j = json[i].msys;
          for (var key in j) { j = j[key]; }
          var row = {};
          // Pull out the values we store as columns along side the JSON
          for (var idx = 0; idx < eventCols.length; idx++) {
            row[eventCols[idx]] = j[eventCols[idx]];
          }
          row.event = JSON.stringify(j);
          values.push(row);
        }
        // Build one query to insert all rows
        const query = pgp.helpers.insert(values, colSet);
        return t.none(query);
      })

    }).then(() => {
      pgp.end();
      callback(null, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: "processed batch "+ objKey })
      });
      // delete from s3 after successful processing
      s3.deleteObject(params).promise().then(() => {
        console.log('deleted processed batch: ['+ objKey +']');
      }).catch((err) => {
        console.log('error deleting duplicate batch ['+ objKey +']: '+ err.message);
      });

    }).catch((err) => {
      pgp.end();
      if (err.message === dupeBatchError) {
        console.log('deleting duplicate batch ['+ objKey +']');
        callback(null, {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: "duplicate batch "+ objKey })
        });
        // delete from s3 on duplicate batch id insert
        s3.deleteObject(params).promise().then(() => {
          console.log('deleted duplicate batch ['+ objKey +']');
        }).catch((err) => {
          console.log('error deleting duplicate batch ['+ objKey +']: '+ err.message);
        });
        return;
      }
      // Not a duplicate batch error.
      console.log(err);
      callback(err);
    });

  }).catch((err) => {
    console.log('s3 handler', err, err.stack);
    callback(err);
  });
};

let qb = squel.useFlavour('postgres');

function isInt(value) {
  if (isNaN(value)) {
    return false;
  }
  let x = parseFloat(value);
  return (x | 0) === x;
}

exports.query_events = (event, context, callback) => {
  // build base query
  let q = qb.select().field('event').from('events')
    , where = squel.expr()
    , defaultTimestamp = true
    , qp = event.queryStringParameters
  ;

  // transform event.queryStringParameters into SQL

  if (qp['bounce_classes'] !== null && qp['bounce_classes'] != undefined) {
    where = where.and('bounce_class IS NOT NULL')
      .and('bounce_class = ANY(?::int[])', [qp['bounce_classes'].split(/\s*,\s*/)]);
  }

  if (qp['campaign_ids'] !== null && qp['campaign_ids'] !== undefined) {
    where = where.and('campaign_ids = ANY(?::text[])', [qp['campaign_ids'].split(/\s*,\s*/)]);
  }

  if (qp['events'] !== null && qp['events'] !== undefined) {
    if (qp['events'].match(/[^a-zA-Z_,]/)) {
      callback(null, {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Illegal character in event type list'
        })
      });
      return;
    }
    where = where.and('type = ANY(?::text[])', [qp['events'].split(/\s*,\s*/)]);
  }

  if (qp['friendly_froms'] !== null && qp['friendly_froms'] !== undefined) {
    where = where.and('friendly_froms = ANY(?::text[])', [qp['friendly_froms'].split(/\s*,\s*/)]);
  }

  if (qp['message_ids'] !== null && qp['message_ids'] !== undefined) {
    where = where.and('message_ids = ANY(?::text[])', [qp['message_ids'].split(/\s*,\s*/)]);
  }

  let perPage = 1000;
  if (qp['per_page'] !== null && qp['per_page'] !== undefined) {
    if (!isInt(qp['per_page'])) {
      callback(null, {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Integer expected for param `per_page`'
        })
      });
      return;
    }
    q = q.limit(qp['per_page']);
  } else {
    q = q.limit(perPage);
  }

  if (qp['page'] !== null && qp['page'] !== undefined) {
    if (!isInt(qp['page'])) {
      callback(null, {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Integer expected for param `page`'
        })
      });
      return;
    }
    q = q.offset(qp['page']);
  }

  if (qp['reason'] !== null && qp['reason'] !== undefined) {
    where = where.and("reason LIKE '%'|| quote_literal(?) ||'%'", qp['reason']);
  }

  if (qp['recipients'] !== null && qp['recipients'] !== undefined) {
    where = where.and('rcpt_to = ANY(?::text[])', [qp['recipients'].split(/\s*,\s*/)]);
  }

  if (qp['subaccounts'] !== null && qp['subaccounts'] !== undefined) {
    where = where.and('subaccount_id IS NOT NULL')
      .and('subaccount_id = ANY(?::int[])', [qp['subaccounts'].split(/\s*,\s*/)]);
  }

  if (qp['template_ids'] !== null && qp['template_ids'] !== undefined) {
    where = where.and('template_id IS NOT NULL')
      .and('template_id = ANY(?::text[])', [qp['template_ids'].split(/\s*,\s*/)]);
  }

  if (qp['transmission_ids'] !== null && qp['transmission_ids'] !== undefined) {
    where = where.and('transmission_id IS NOT NULL')
      .and('transmission_id = ANY(?::bigint[])', [qp['transmission_ids'].split(/\s*,\s*/)]);
  }


  const toEpoch = "date_part('epoch', (?::timestamptz))";
  if (qp['from'] !== null && qp['from'] !== undefined &&
      qp['to'] !== null && qp['to'] !== undefined
  ) {
    defaultTimestamp = false;
    where = where.and('"timestamp" BETWEEN ? AND ?',
      squel.str(toEpoch, qp['from']),
      squel.str(toEpoch, qp['to']))
  } else if (qp['from'] !== null && qp['from'] !== undefined) {
    defaultTimestamp = false;
    where = where.and('"timestamp" BETWEEN ? AND ?',
      squel.str(toEpoch, qp['from']),
      squel.str("date_part('epoch', NOW())"));
  } else if (qp['to'] !== null && qp['to'] !== undefined) {
    console.log('Cannot specify `to` without `from`');
    callback(null, {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Cannot specify `to` without `from`'
      })
    });
    return;
  }

  if (defaultTimestamp === true) {
    where = where.and(
        // set the default date range to query
        '"timestamp" BETWEEN ? AND ?',
        squel.str("date_part('epoch', (NOW() - interval '1 day'))"),
        squel.str("date_part('epoch', NOW())"))
  }

  q = q.where(where); // add the where expression to the query object
  const query = q.toParam();
  console.log(JSON.stringify(query));
  const dbh = pgp(pgCfg);
  dbh.any(query['text'], query['values'])
    .then((data) => {
      console.log('data: '+ JSON.stringify(data));
      callback(null, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      pgp.end();
    })
    .catch((err) => {
      callback(err);
      pgp.end();
    });
};
