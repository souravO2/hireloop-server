import express from "express";
import cors from "cors";
import "dotenv/config";
import { MongoClient } from "mongodb";
import { ObjectId } from "mongodb";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 5000;

//middleware
app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MDB_URI);

const myLogger = (req, res, next) => {
  console.log("LOGGED");
  next();
};

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db("hireloop");
const users = db.collection("user");
const sessions = db.collection("session");
const jobs = db.collection("jobs");
const applications = db.collection("applications");
const payments = db.collection("payments");

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  const query = { token };
  const session = await sessions.findOne(query);
  if (!session) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  const userId = session.userId;
  const user = await users.findOne({ _id: new ObjectId(userId) });
  if (!user) {
    return res.status(401).send({ message: "Unauthorized access" });
  }
  req.user = user;
  next();
};

//must call this after verifyToken middleware
const verifySeeker = async (req, res, next) => {
  if (req.user.role !== "seeker") {
    return res.status(403).send({ message: "Forbidden access" });
  }
  next();
};

const verifyRecruiter = async (req, res, next) => {
  if (req.user.role !== "recruiter") {
    return res.status(403).send({ message: "Forbidden access" });
  }
  next();
};

const verifyAdmin = async (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).send({ message: "Forbidden access" });
  }
  next();
};

app.get("/", (req, res) => {
  res.send("Server is running");
});

//user related api
app.get("/users", async (req, res) => {
  const cursor = users.find({});
  const result = await cursor.toArray();
  res.send(result);
});

app.get("/users/:id/premium", async (req, res) => {
  const { id } = req.params;
  const query = { _id: new ObjectId(id) };
  const result = await users.findOne(query, { projection: { premium: 1 } });
  res.send(result);
});

app.patch("/users/:id/role", verifyToken, verifyAdmin, async (req, res) => {
  const { id } = req.params;
  const query = { _id: new ObjectId(id) };
  const updatedDoc = {
    $set: {
      role: req.body.role,
    },
  };
  const result = await users.updateOne(query, updatedDoc);
  res.send(result);
});

//job related api
app.post("/jobs", verifyToken, verifyRecruiter, async (req, res) => {
  const job = await req.body;
  const result = await jobs.insertOne(job);
  res.send(result);
});

app.get("/jobs", async (req, res) => {
  const query = {};
  if (req.query) {
    if (req.query.jobType) {
      query.jobType = req.query.jobType;
    }
    if (req.query.isRemote) {
      query.isRemote = req.query.isRemote === "true";
    }
    if (req.query.category) {
      query.category = req.query.category;
    }
    if (req.query.recruiterId) {
      query.recruiterId = req.query.recruiterId;
    }
    if (req.query.search) {
      query.$or = [
        { title: { $regex: req.query.search, $options: "i" } },
        { responsibilities: { $regex: req.query.search, $options: "i" } },
        { requirement: { $regex: req.query.search, $options: "i" } },
      ];
    }
  }
  const cursor = jobs.find(query);
  const result = await cursor.toArray();
  res.send(result);
});

app.get(`/jobs/:id`, async (req, res) => {
  const { id } = req.params;
  const result = await jobs.findOne({ _id: new ObjectId(id) });
  res.send(result);
});

app.delete("/jobs/:id", async (req, res) => {
  const { id } = req.params;
  const result = await jobs.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
});

//applications
app.post("/applications", verifyToken, verifySeeker, async (req, res) => {
  const application = req.body;
  const result = await applications.insertOne(application);
  res.send(result);
});

app.get("/applications", verifyToken, async (req, res) => {
  const query = {};
  if (req.query.applicantId) {
    query.userId = req.query.applicantId;
  }
  if (req.query.jobId) {
    const jobQuery = { _id: new ObjectId(req.query.jobId) };
    const job = await jobs.findOne(jobQuery);
    if (
      job.recruiterId !== req.user._id.toString() &&
      req.user.role !== "admin"
    ) {
      return res.status(403).send({ message: "forbidden" });
    }
    query.jobId = req.query.jobId;
  }
  const cursor = applications.find(query);
  const result = await cursor.toArray();
  res.send(result);
});
app.get("/applications/count", async (req, res) => {
  const query = {};
  if (req.query.applicantId) {
    query.userId = req.query.applicantId;
  }
  const result = await applications.countDocuments(query);
  res.send({ count: result });
});

app.patch("/applications/:id", async (req, res) => {
  const { id } = req.params;
  const query = { _id: new ObjectId(id) };
  const updatedDoc = {
    $set: {
      status: req.body.status,
    },
  };
  const result = await applications.updateOne(query, updatedDoc);
  res.send(result);
});

//payments related api
app.post("/payments/checkout-verify", async (req, res) => {
  const { sessionId } = req.body;
  const { status, payment_status, customer_email, metadata, payment_intent } =
    await stripe.checkout.sessions.retrieve(sessionId);

  // check is new payment or not
  // check if the sessionId for the currently logged in user
  //insert sessionId into payments collection
  // update user info as premium user
  if (status === "complete" && payment_status === "paid") {
    const sessionQuery = { sessionId };
    const existingPayment = await payments.findOne(sessionQuery);
    if (existingPayment) {
      return res.send({ success: false, message: "Payment already verified" });
    }

    const payment = {
      sessionId,
      status,
      payment_status,
      customer_email,
      userId: metadata.userId,
      payment_intent,
      paymentDate: new Date(),
    };
    const result = await payments.insertOne(payment);

    // update the user table
    const query = { _id: new ObjectId(metadata.userId) };

    const updatedDoc = {
      $set: {
        premium: true,
      },
    };
    const updateResult = await users.updateOne(query, updatedDoc);
    res.send({ success: true, result, updateResult });
    return;
  }
  res.send({ success: false, message: "Payment not verified" });
});

app.listen(PORT, () => {
  console.log(`API is running on Port : ${PORT}`);
});
