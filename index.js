'use strict';
//var AWS = require('aws-sdk');

console.log('loading function');

const bucketName = process.env.BUCKET_NAME;
const createResponse = (statusCode, body) => {
  return {
    "statusCode": statusCode,
    "body": body || ""
  };
};

exports.store_batch = (event, context, callback) => {
  //var s3 = new AWS.S3();
  console.log('would store batch to '+ bucketName);
  return createResponse(200, "would store batch to "+ bucketName);
}
