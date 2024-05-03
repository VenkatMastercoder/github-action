/* eslint-disable no-unused-vars */
/* eslint-disable no-undef */
const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const stripe = require("stripe")(process.env.STRIPE_SECRET);

const app = express();
const PORT = process.env.PORT;

const prisma = new PrismaClient();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

app.post("/order", async (req, res) => {
  try {
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_SECRET,
    });

    const options = req.body;
    const order = await razorpay.orders.create(options);

    if (!order) {
      return res.status(500).send("Error");
    }

    res.json(order);
  } catch (err) {
    res.status(500).send("Error");
  }
});

app.post("/order/validate", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } =
    req.body;

  const sha = crypto.createHmac("sha256", process.env.RAZORPAY_SECRET);
  // order_id + "|" + razorpay_payment_id
  sha.update(`${razorpay_order_id}|${razorpay_payment_id}`);
  const digest = sha.digest("hex");

  if (digest !== razorpay_signature) {
    return res.status(400).json({ msg: "Transaction is not legit!" });
  }

  res.json({
    msg: "success",
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
  });
});

// Webhook endpoint to handle order.paid events
app.post("/webhook", async (req, res) => {
  const payload = req.body;

  // Check if the event is order.paid
  if (payload && payload.entity === "event" && payload.event === "order.paid") {
    // Extract payment and order information from the payload
    const paymentInfo = payload.payload.payment.entity;
    const orderInfo = payload.payload.order.entity;

    try {
      // Add payment to the database
      const payment = await prisma.payment.create({
        data: {
          id: paymentInfo.id,
          amount: paymentInfo.amount,
          currency: paymentInfo.currency,
          status: paymentInfo.status,
          order_id: paymentInfo.order_id,
          method: paymentInfo.method,
          description: paymentInfo.description,
          vpa: paymentInfo.vpa,
          email: paymentInfo.email,
          contact: paymentInfo.contact,
          fee: paymentInfo.fee,
          tax: paymentInfo.tax,
          notes: paymentInfo.notes,
          created_at: new Date(paymentInfo.created_at * 1000),
        },
      });

      // Add order to the database
      const order = await prisma.order.create({
        data: {
          id: orderInfo.id,
          amount: orderInfo.amount,
          amount_paid: orderInfo.amount_paid,
          amount_due: orderInfo.amount_due,
          currency: orderInfo.currency,
          receipt: orderInfo.receipt,
          status: orderInfo.status,
          attempts: orderInfo.attempts,
          created_at: new Date(orderInfo.created_at * 1000),
        },
      });

      // Send a success response to the webhook provider
      res.status(200).send("Webhook received successfully");
    } catch (error) {
      console.error("Error adding payment or order:", error);
      // Send an error response to the webhook provider
      res.status(500).send("Internal server error");
    }
  } else {
    // If the event is not order.paid, ignore the webhook
    res.status(400).send("Invalid webhook payload");
  }
});

// Stripe
app.post("/create-checkout-session", async (req, res) => {
  const { products } = req.body;

  const lineItems = products.map((product) => ({
    price_data: {
      currency: "inr",
      product_data: {
        name: product.dish,
        images: [product.imgdata],
      },
     unit_amount: Math.round(product.price * 100),
    },
    quantity: product.qnty,
  }));

  console.log(lineItems)

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: lineItems,
    mode: "payment",
    success_url: "http://localhost:3000/sucess",
    cancel_url: "http://localhost:3000/cancel",
  });

  res.json({ id: session.id });
});

app.post('stripe/webhook', express.raw({type: 'application/json'}), (request, response) => {
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_SECRET);
  } catch (err) {
    response.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  // Handle the event
  console.log(`Unhandled event type ${event.type}`);

  // Return a 200 response to acknowledge receipt of the event
  response.send();
});

app.get("/data", async (req, res) => {
  try {
    // Retrieve all payments from the database
    const payments = await prisma.payment.findMany();

    // Retrieve all orders from the database
    const orders = await prisma.order.findMany();

    res.json({ payments, orders });
  } catch (error) {
    console.error("Error retrieving data:", error);
    // Send an error response if there's an issue with database retrieval
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log("Listening on port", PORT);
});
