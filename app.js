"use strict";

const dialogflow = require("dialogflow");
const config = require("./config");
const express = require("express");
const crypto = require("crypto");
const bodyParser = require("body-parser");
const request = require("request");
const app = express();
const uuid = require("uuid");
const axios = require("axios");

// Messenger API parameters
if (!config.FB_PAGE_TOKEN) {
  throw new Error("missing FB_PAGE_TOKEN");
}
if (!config.FB_VERIFY_TOKEN) {
  throw new Error("missing FB_VERIFY_TOKEN");
}
if (!config.GOOGLE_PROJECT_ID) {
  throw new Error("missing GOOGLE_PROJECT_ID");
}
if (!config.DF_LANGUAGE_CODE) {
  throw new Error("missing DF_LANGUAGE_CODE");
}
if (!config.GOOGLE_CLIENT_EMAIL) {
  throw new Error("missing GOOGLE_CLIENT_EMAIL");
}
if (!config.GOOGLE_PRIVATE_KEY) {
  throw new Error("missing GOOGLE_PRIVATE_KEY");
}
if (!config.FB_APP_SECRET) {
  throw new Error("missing FB_APP_SECRET");
}
if (!config.SERVER_URL) {
  //used for ink to static files
  throw new Error("missing SERVER_URL");
}

app.set("port", process.env.PORT || 5000);

//verify request came from facebook
app.use(
  bodyParser.json({
    verify: verifyRequestSignature,
  })
);

//serve static files in the public directory
app.use(express.static("public"));

// Process application/x-www-form-urlencoded
app.use(
  bodyParser.urlencoded({
    extended: false,
  })
);

// Process application/json
app.use(bodyParser.json());

const credentials = {
  client_email: config.GOOGLE_CLIENT_EMAIL,
  private_key: config.GOOGLE_PRIVATE_KEY,
};

const sessionClient = new dialogflow.SessionsClient({
  projectId: config.GOOGLE_PROJECT_ID,
  credentials,
});

const sessionIds = new Map();

// Index route
app.get("/", function (req, res) {
  res.send("Hello world, I am a chat bot");
});

// for Facebook verification
app.get("/webhook/", function (req, res) {
  debugger;
  console.log("request");
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === config.FB_VERIFY_TOKEN
  ) {
    res.status(200).send(req.query["hub.challenge"]);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page.
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post("/webhook/", function (req, res) {
  var data = req.body;
  console.log(JSON.stringify(data));

  // Make sure this is a page subscription
  if (data.object == "page") {
    // Iterate over each entry
    // There may be multiple if batched
    data.entry.forEach(function (pageEntry) {
      var pageID = pageEntry.id;
      var timeOfEvent = pageEntry.time;

      // Iterate over each messaging event
      pageEntry.messaging.forEach(function (messagingEvent) {
        if (messagingEvent.optin) {
          receivedAuthentication(messagingEvent);
        } else if (messagingEvent.message) {
          receivedMessage(messagingEvent);
        } else if (messagingEvent.delivery) {
          receivedDeliveryConfirmation(messagingEvent);
        } else if (messagingEvent.postback) {
          receivedPostback(messagingEvent);
        } else if (messagingEvent.read) {
          receivedMessageRead(messagingEvent);
        } else if (messagingEvent.account_linking) {
          receivedAccountLink(messagingEvent);
        } else {
          console.log(
            "Webhook received unknown messagingEvent: ",
            messagingEvent
          );
        }
      });
    });

    // Assume all went well.
    // You must send back a 200, within 20 seconds
    res.sendStatus(200);
  }
});

function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  if (!sessionIds.has(senderID)) {
    sessionIds.set(senderID, uuid.v1());
  }
  //console.log("Received message for user %d and page %d at %d with message:", senderID, recipientID, timeOfMessage);
  //console.log(JSON.stringify(message));

  var isEcho = message.is_echo;
  var messageId = message.mid;
  var appId = message.app_id;
  var metadata = message.metadata;

  // You may get a text or attachment but not both
  var messageText = message.text;
  var messageAttachments = message.attachments;
  var quickReply = message.quick_reply;

  if (isEcho) {
    handleEcho(messageId, appId, metadata);
    return;
  } else if (quickReply) {
    handleQuickReply(senderID, quickReply, messageId);
    return;
  }

  if (messageText) {
    //send message to api.ai
    sendToDialogFlow(senderID, messageText);
  } else if (messageAttachments) {
    handleMessageAttachments(messageAttachments, senderID);
  }
}

function handleMessageAttachments(messageAttachments, senderID) {
  //for now just reply
  sendTextMessage(senderID, "Attachment received. Thank you.");
}

function handleQuickReply(senderID, quickReply, messageId) {
  var quickReplyPayload = quickReply.payload;
  console.log(
    "Quick reply for message %s with payload %s",
    messageId,
    quickReplyPayload
  );
  //send payload to api.ai
  sendToDialogFlow(senderID, quickReplyPayload);
}

//https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-echo
function handleEcho(messageId, appId, metadata) {
  // Just logging message echoes to console
  console.log(
    "Received echo for message %s and app %d with metadata %s",
    messageId,
    appId,
    metadata
  );
}

async function handleDialogFlowAction(
  sender,
  action,
  messages,
  contexts,
  parameters
) {
  switch (action) {
    case "check_availability":
      if (parameters) {
        let bookingDate = parameters.fields["Date"].stringValue;
        if (bookingDate !== "" && bookingDate.includes("T")) {
          bookingDate = bookingDate.substr(0, 10);

          try {
            const response = await axios.post(
              "https://nexus-hotel-bot-backend.herokuapp.com/isAvailable",
              { date: bookingDate }
            );

            if (response.status === 200) {
              const data = Object.entries(response.data);
              let text = ``;
              data.forEach((item) => {
                text += `${item[0]}: ${item[1]}\n`;
              });

              sendTextMessage(
                sender,
                `Following is the availablity of rooms on ${bookingDate}`
              );
              sendTextMessage(sender, text);
            } else {
              sendTextMessage(sender, response.data);
            }
          } catch (error) {
            sendTextMessage(sender, "Error has occured");
            sendTextMessage(sender, "Sorry for your trouble, Please try again");
          }
        } else {
          handleMessages(messages, sender);
        }
      } else {
        handleMessages(messages, sender);
      }
      break;
    case "cancel_booking":
      if (parameters) {
        let bookingToken = parameters.fields["bookingToken"].stringValue;
        let confirmCancel = parameters.fields["confirmCancel"].stringValue;

        if (bookingToken === "" && confirmCancel === "") {
          try {
            const response = await axios.get(
              `https://nexus-hotel-bot-backend.herokuapp.com/booking/info/id/${sender}`
            );

            if (response.status === 200) {
              let replies = [];
              const bookings = response.data;
              if (bookings.length > 0) {
                bookings.forEach((booking) => {
                  let bookingDate = "";
                  if (
                    booking.bookingDate !== "" &&
                    booking.bookingDate.includes("T")
                  ) {
                    bookingDate = booking.bookingDate.substr(0, 10);
                  }

                  replies.push(
                    `Booking Date: ${bookingDate} \nRoomType : ${booking.roomType} \nBooking Token: ${booking.token} \nNumber of Rooms: ${booking.numberOfRooms} \nNumber of Days: ${booking.numberOfDays}`
                  );
                  //   replies.push({
                  //     "content_type": "text",
                  //     "title": `Date: ${bookingDate} \n RoomType: ${booking.roomType}`,
                  //     "payload": `${booking.token}`,
                  //   });
                });

                replies.forEach((reply) => {
                  sendTextMessage(sender, reply);
                });
                handleMessages(messages, sender);
                // sendQuickReply(sender, messages[0].text.text[0], replies);
              } else {
                sendTextMessage(sender, "You have no bookings");
                sendToDialogFlow(sender, "cancel");
              }
            } else {
              sendTextMessage(sender, "Some error occurred. Please try again");
            }
          } catch (error) {
            sendTextMessage(sender, "Error has occured");
            sendTextMessage(sender, "Sorry for your trouble, Please try again");
          }
        } else if (bookingToken !== "" && confirmCancel === "") {
          const replies = [
            {
              "content_type": "text",
              "title": `Yes`,
              "payload": `yes`,
            },
            {
              "content_type": "text",
              "title": `No`,
              "payload": `no`,
            },
          ];
          sendQuickReply(sender, messages[0].text.text[0], replies);
        } else if (bookingToken !== "" && confirmCancel === "yes") {
          try {
            const response = await axios.delete(
              `https://nexus-hotel-bot-backend.herokuapp.com/booking/cancellation/${bookingToken}`
            );

            if (response.status === 200)
              sendTextMessage(sender, "Booking Cancelled Successfully");
            else
              sendTextMessage(sender, "Some error occurred. Please try again");
          } catch (error) {
            sendTextMessage(sender, "Error has occured");
            sendTextMessage(sender, "Sorry for your trouble, Please try again");
          }
        } else if (bookingToken !== "" && confirmCancel === "no") {
          sendTextMessage(sender, "Ok! Booking not cancelled. Enjoy your stay");
        } else {
          handleMessages(messages, sender);
        }
      } else {
        handleMessages(messages, sender);
      }
      break;
    case "confirm_booking":
      for (let i = 0; i < contexts.length; i++) {
        //Extracting the context name
        let contextName = "";
        for (let j = contexts[i].name.length - 1; j >= 0; j--) {
          if (contexts[i].name[j] === "/") {
            contextName = contexts[i].name.substring(j + 1);
            break;
          }
        }

        //Extracting data from context and making the API call
        if (contextName === "confirm_room") {
          // Getting all the values from params in variables
          let age = contexts[i].parameters.fields["age"].numberValue;
          let bookingDate =
            contexts[i].parameters.fields["bookingDate"].stringValue;
          let name = contexts[i].parameters.fields["name"].stringValue;
          let aadhaarUID =
            contexts[i].parameters.fields["aadhaarUID"].numberValue;
          let roomType = contexts[i].parameters.fields["roomType"].stringValue;
          let numberOfDays =
            contexts[i].parameters.fields["numberOfDays"].numberValue;
          let numberOfRooms =
            contexts[i].parameters.fields["numberOfRooms"].numberValue;
          let email = contexts[i].parameters.fields["email"].stringValue;
          let gender = contexts[i].parameters.fields["gender"].stringValue;

          // Changing the bookingDate format to (YYYY-MM-DD)
          if (bookingDate !== "" && bookingDate.includes("T")) {
            bookingDate = bookingDate.substr(0, 10);
          }

          const reqBody = {
            userID: sender.toString(),
            age,
            bookingDate,
            name,
            aadhaarUID: aadhaarUID.toString(),
            roomType,
            numberOfDays,
            numberOfRooms,
            email,
            gender,
          };

          //Making the api call
          try {
            const response = await axios.post(
              "https://nexus-hotel-bot-backend.herokuapp.com/booking",
              reqBody
            );
            if (response.status === 201) {
              handleMessages(messages, sender);
              sendTextMessage(
                sender,
                `Here is your Booking Token for future reference. Please save it somewhere. \nBooking Token : ${response.data.token}`
              );
            } else if (response.status === 400) {
              sendTextMessage(sender, response.data);
            } else {
              sendTextMessage(
                sender,
                "Some error occured while booking. Please try again later"
              );
            }
          } catch (error) {
            if (
              error.response &&
              (error.response.status === 500 ||
                error.response.status === 400) &&
              typeof error.response.data === "string"
            )
              sendTextMessage(sender, error.response.data);
            else {
              sendTextMessage(sender, "Error has occured");
              sendTextMessage(
                sender,
                "Sorry for your trouble, Please try to book again"
              );
            }
          }

          break;
        }
      }

      break;
    case "booking_details":
      if (parameters) {
        let roomType = parameters.fields["roomType"].stringValue;

        //Sending quick replies for the room type
        if (messages && roomType === "") {
          for (let i = 0; i < messages.length; i++) {
            if (
              messages[i].platform === "PLATFORM_UNSPECIFIED" &&
              messages[i].text.text[0] ===
                "Please choose your room type from the following"
            ) {
              let replies = [
                {
                  "content_type": "text",
                  "title": "SingleRoom",
                  "payload": "SingleRoom",
                },
                {
                  "content_type": "text",
                  "title": "DoubleRoom",
                  "payload": "DoubleRoom",
                },
                {
                  "content_type": "text",
                  "title": "TripleRoom",
                  "payload": "TripleRoom",
                },
                {
                  "content_type": "text",
                  "title": "QwadRoom",
                  "payload": "QwadRoom",
                },
                {
                  "content_type": "text",
                  "title": "TwinRoom",
                  "payload": "TwinRoom",
                },
                {
                  "content_type": "text",
                  "title": "DeluxeRoom",
                  "payload": "DeluxeRoom",
                },
                {
                  "content_type": "text",
                  "title": "SuperDeluxeRoom",
                  "payload": "SuperDeluxeRoom",
                },
                {
                  "content_type": "text",
                  "title": "StudioRoom",
                  "payload": "StudioRoom",
                },
                {
                  "content_type": "text",
                  "title": "ExecutiveSuiteRoom",
                  "payload": "ExecutiveSuiteRoom",
                },
                {
                  "content_type": "text",
                  "title": "PresidentialSuiteRoom",
                  "payload": "PresidentialSuiteRoom",
                },
              ];
              sendQuickReply(sender, messages[i].text.text[0], replies);
              break;
            }
          }
        } else {
          handleMessages(messages, sender);
        }
      }
      break;
    default:
      //unhandled action, just send back the text
      handleMessages(messages, sender);
  }
}

function handleMessage(message, sender) {
  switch (message.message) {
    case "text": //text
      message.text.text.forEach((text) => {
        if (text !== "") {
          sendTextMessage(sender, text);
        }
      });
      break;
    case "quickReplies": //quick replies
      let replies = [];
      message.quickReplies.quickReplies.forEach((text) => {
        let reply = {
          content_type: "text",
          title: text,
          payload: text,
        };
        replies.push(reply);
      });
      sendQuickReply(sender, message.quickReplies.title, replies);
      break;
    case "image": //image
      sendImageMessage(sender, message.image.imageUri);
      break;
  }
}

function handleCardMessages(messages, sender) {
  let elements = [];
  for (var m = 0; m < messages.length; m++) {
    let message = messages[m];
    let buttons = [];
    for (var b = 0; b < message.card.buttons.length; b++) {
      let isLink = message.card.buttons[b].postback.substring(0, 4) === "http";
      let button;
      if (isLink) {
        button = {
          type: "web_url",
          title: message.card.buttons[b].text,
          url: message.card.buttons[b].postback,
        };
      } else {
        button = {
          type: "postback",
          title: message.card.buttons[b].text,
          payload: message.card.buttons[b].postback,
        };
      }
      buttons.push(button);
    }

    let element = {
      title: message.card.title,
      image_url: message.card.imageUri,
      subtitle: message.card.subtitle,
      buttons: buttons,
    };
    elements.push(element);
  }
  sendGenericMessage(sender, elements);
}

function handleMessages(messages, sender) {
  let timeoutInterval = 1100;
  let previousType;
  let cardTypes = [];
  let timeout = 0;
  for (var i = 0; i < messages.length; i++) {
    if (
      previousType == "card" &&
      (messages[i].message != "card" || i == messages.length - 1)
    ) {
      timeout = (i - 1) * timeoutInterval;
      setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
      cardTypes = [];
      timeout = i * timeoutInterval;
      setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
    } else if (messages[i].message == "card" && i == messages.length - 1) {
      cardTypes.push(messages[i]);
      timeout = (i - 1) * timeoutInterval;
      setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
      cardTypes = [];
    } else if (messages[i].message == "card") {
      cardTypes.push(messages[i]);
    } else {
      timeout = i * timeoutInterval;
      setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
    }

    previousType = messages[i].message;
  }
}

function handleDialogFlowResponse(sender, response) {
  let responseText = response.fulfillmentMessages.fulfillmentText;

  let messages = response.fulfillmentMessages;
  let action = response.action;
  let contexts = response.outputContexts;
  let parameters = response.parameters;

  sendTypingOff(sender);

  if (isDefined(action)) {
    handleDialogFlowAction(sender, action, messages, contexts, parameters);
  } else if (isDefined(messages)) {
    handleMessages(messages, sender);
  } else if (responseText == "" && !isDefined(action)) {
    //dialogflow could not evaluate input.
    sendTextMessage(
      sender,
      "I'm not sure what you want. Can you be more specific?"
    );
  } else if (isDefined(responseText)) {
    sendTextMessage(sender, responseText);
  }
}

async function sendToDialogFlow(sender, textString, params) {
  sendTypingOn(sender);

  try {
    const sessionPath = sessionClient.sessionPath(
      config.GOOGLE_PROJECT_ID,
      sessionIds.get(sender)
    );

    const request = {
      session: sessionPath,
      queryInput: {
        text: {
          text: textString,
          languageCode: config.DF_LANGUAGE_CODE,
        },
      },
      queryParams: {
        payload: {
          data: params,
        },
      },
    };
    const responses = await sessionClient.detectIntent(request);

    const result = responses[0].queryResult;
    handleDialogFlowResponse(sender, result);
  } catch (e) {
    console.log("error");
    console.log(e);
  }
}

function sendTextMessage(recipientId, text) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      text: text,
    },
  };
  callSendAPI(messageData);
}

/*
 * Send an image using the Send API.
 *
 */
function sendImageMessage(recipientId, imageUrl) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: imageUrl,
        },
      },
    },
  };

  callSendAPI(messageData);
}

/*
 * Send a Gif using the Send API.
 *
 */
function sendGifMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: config.SERVER_URL + "/assets/instagram_logo.gif",
        },
      },
    },
  };

  callSendAPI(messageData);
}

/*
 * Send audio using the Send API.
 *
 */
function sendAudioMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "audio",
        payload: {
          url: config.SERVER_URL + "/assets/sample.mp3",
        },
      },
    },
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example videoName: "/assets/allofus480.mov"
 */
function sendVideoMessage(recipientId, videoName) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "video",
        payload: {
          url: config.SERVER_URL + videoName,
        },
      },
    },
  };

  callSendAPI(messageData);
}

/*
 * Send a video using the Send API.
 * example fileName: fileName"/assets/test.txt"
 */
function sendFileMessage(recipientId, fileName) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "file",
        payload: {
          url: config.SERVER_URL + fileName,
        },
      },
    },
  };

  callSendAPI(messageData);
}

/*
 * Send a button message using the Send API.
 *
 */
function sendButtonMessage(recipientId, text, buttons) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: text,
          buttons: buttons,
        },
      },
    },
  };

  callSendAPI(messageData);
}

function sendGenericMessage(recipientId, elements) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: elements,
        },
      },
    },
  };

  callSendAPI(messageData);
}

function sendReceiptMessage(
  recipientId,
  recipient_name,
  currency,
  payment_method,
  timestamp,
  elements,
  address,
  summary,
  adjustments
) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random() * 1000);

  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: recipient_name,
          order_number: receiptId,
          currency: currency,
          payment_method: payment_method,
          timestamp: timestamp,
          elements: elements,
          address: address,
          summary: summary,
          adjustments: adjustments,
        },
      },
    },
  };

  callSendAPI(messageData);
}

/*
 * Send a message with Quick Reply buttons.
 *
 */
function sendQuickReply(recipientId, text, replies, metadata) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      text: text,
      metadata: isDefined(metadata) ? metadata : "",
      quick_replies: replies,
    },
  };

  callSendAPI(messageData);
}

/*
 * Send a read receipt to indicate the message has been read
 *
 */
function sendReadReceipt(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    sender_action: "mark_seen",
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator on
 *
 */
function sendTypingOn(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    sender_action: "typing_on",
  };

  callSendAPI(messageData);
}

/*
 * Turn typing indicator off
 *
 */
function sendTypingOff(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    sender_action: "typing_off",
  };

  callSendAPI(messageData);
}

/*
 * Send a message with the account linking call-to-action
 *
 */
function sendAccountLinking(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId,
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Welcome. Link your account.",
          buttons: [
            {
              type: "account_link",
              url: config.SERVER_URL + "/authorize",
            },
          ],
        },
      },
    },
  };

  callSendAPI(messageData);
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll
 * get the message id in a response
 *
 */
function callSendAPI(messageData) {
  request(
    {
      uri: "https://graph.facebook.com/v3.2/me/messages",
      qs: {
        access_token: config.FB_PAGE_TOKEN,
      },
      method: "POST",
      json: messageData,
    },
    function (error, response, body) {
      if (!error && response.statusCode == 200) {
        var recipientId = body.recipient_id;
        var messageId = body.message_id;

        if (messageId) {
          console.log(
            "Successfully sent message with id %s to recipient %s",
            messageId,
            recipientId
          );
        } else {
          console.log(
            "Successfully called Send API for recipient %s",
            recipientId
          );
        }
      } else {
        console.error(
          "Failed calling Send API",
          response.statusCode,
          response.statusMessage,
          body.error
        );
      }
    }
  );
}

/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 *
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // The 'payload' param is a developer-defined field which is set in a postback
  // button for Structured Messages.
  var payload = event.postback.payload;

  switch (payload) {
    default:
      //unindentified payload
      sendTextMessage(
        senderID,
        "I'm not sure what you want. Can you be more specific?"
      );
      break;
  }

  console.log(
    "Received postback for user %d and page %d with payload '%s' " + "at %d",
    senderID,
    recipientID,
    payload,
    timeOfPostback
  );
}

/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 *
 */
function receivedMessageRead(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  // All messages before watermark (a timestamp) or sequence have been seen.
  var watermark = event.read.watermark;
  var sequenceNumber = event.read.seq;

  console.log(
    "Received message read event for watermark %d and sequence " + "number %d",
    watermark,
    sequenceNumber
  );
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 *
 */
function receivedAccountLink(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;

  var status = event.account_linking.status;
  var authCode = event.account_linking.authorization_code;

  console.log(
    "Received account link event with for user %d with status %s " +
      "and auth code %s ",
    senderID,
    status,
    authCode
  );
}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function (messageID) {
      console.log(
        "Received delivery confirmation for message ID: %s",
        messageID
      );
    });
  }

  console.log("All message before %d were delivered.", watermark);
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to
 * Messenger" plugin, it is the 'data-ref' field. Read more at
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfAuth = event.timestamp;

  // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
  // The developer can set this to an arbitrary value to associate the
  // authentication callback with the 'Send to Messenger' click event. This is
  // a way to do account linking when the user clicks the 'Send to Messenger'
  // plugin.
  var passThroughParam = event.optin.ref;

  console.log(
    "Received authentication for user %d and page %d with pass " +
      "through param '%s' at %d",
    senderID,
    recipientID,
    passThroughParam,
    timeOfAuth
  );

  // When an authentication is received, we'll send a message back to the sender
  // to let them know it was successful.
  sendTextMessage(senderID, "Authentication successful");
}

/*
 * Verify that the callback came from Facebook. Using the App Secret from
 * the App Dashboard, we can verify the signature that is sent with each
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    throw new Error("Couldn't validate the signature.");
  } else {
    var elements = signature.split("=");
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto
      .createHmac("sha1", config.FB_APP_SECRET)
      .update(buf)
      .digest("hex");

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

function isDefined(obj) {
  if (typeof obj == "undefined") {
    return false;
  }

  if (!obj) {
    return false;
  }

  return obj != null;
}

// Spin up the server
app.listen(app.get("port"), function () {
  console.log("running on port", app.get("port"));
});
