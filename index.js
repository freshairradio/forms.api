const mongoose = require("mongoose");
const express = require("express");
const fetch = require("node-fetch");
const AWS = require("aws-sdk");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;
const md5 = require("md5");

var MAILGUN_API_KEY = process.env.MAILGUN_TOKEN;
var DOMAIN = 'mailgun.freshair.radio';
var mailgun = require('mailgun.js');
const mg = mailgun.client({
  url: 'https://api.eu.mailgun.net', // To use EU domains
  username: 'api',
  key: MAILGUN_API_KEY,
});
const app = express();
app.use(cors());
const port = process.env.PORT || 8764;
const spacesEndpoint = new AWS.Endpoint("nyc3.digitaloceanspaces.com");
// const GhostAdminAPI = require("@tryghost/admin-api");
// const ghostToken = process.env.GHOST_TOKEN;
// const Admin = new GhostAdminAPI({
//   url: "https://content.freshair.org.uk",
//   key: ghostToken,
//   version: "v3"
// });
const Form = mongoose.model(
  `Form`,
  new mongoose.Schema(
    {
      user: String,
      slug: String,
      data: Object,
      path: [String]
    },
    {
      typePojoToMixed: false,
      typeKey: "$type",
      timestamps: true
    }
  )
);

mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/prod", {
  useNewUrlParser: true
});

const s3 = new AWS.S3({
  endpoint: spacesEndpoint,
  accessKeyId: process.env.ACCESS_KEY,
  secretAccessKey: process.env.SECRET_KEY
});

const upload = multer({
  dest: "/tmp",
  limits: { fileSize: 524288000 }
});

app.post("/upload", upload.single("upload"), async (req, res) => {
  if (!req.file) {
    return res.status(400);
  }
  let data = await fs.readFile(req.file.path);
  let name = md5(data);
  const params = {
    Body: data,
    Bucket: "freshair",
    Key: `upload/${name}`,
    ACL: "public-read",
    ContentType: req.file.mimetype
  };
  res.send(name);
  s3.putObject(params, (err, data) => {
    if (err) console.error(err, err.stack);
    else {
      console.log(`Uploaded: ${name}`);
    }
  });
});

app.use(express.json());
app.get("/spec/:slug", async (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z-]+/g, "-").toLowerCase();
  try {
    return res.json(
      JSON.parse(await fs.readFile(`./forms/${slug}.json`, "utf8"))
    );
  } catch (e) {
    return res.status(500);
  }
});

app.post("/submit/:slug", async (req, res) => {
  try {
    let { data, path } = req.body;
    let auth = req.headers["x-auth-token"];
    let slug = req.params.slug.replace(/[^a-zA-Z-]+/g, "-").toLowerCase();

    console.log(data);

    await Form.create({
      user: "freshair-member",
      slug,
      data,
      path
    });

    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    var availability = {
      "Monday": [],
      "Tuesday": [],
      "Wednesday": [],
      "Thursday": [],
      "Friday": [],
      "Saturday": [],
      "Sunday": []
    };

    data.broadcast_time.forEach((time) => {
      var day = days[(time[1] % 7)];
      var hour = time[0];
      availability[day] += hour + ", ";
    });

    mg.messages.create(DOMAIN, {
      from: 'applications@mailgun.freshair.radio',
      // to: 'webmaster@freshair.radio',
      to: 'programming@freshair.radio',
      cc: 'webmaster@freshair.radio, manager@freshair.radio',
      subject: `Show Application for ${data.show_details.name}`,
      text: `
      Show Name: ${data.show_details.name} 
      Show Description: ${data.show_details.description} 
      Name: ${data.personal_details.name} 
      Email: ${data.personal_details.email} 
      SSN: ${data.personal_details.ssn} 
      Other people: ${data.show_people.name} 
      Show Category: ${data.show_category.name}
      Availability: ${JSON.stringify(availability, null, '\t')}
      Agreed to content guidelines?: ${data.content_guidelines}
      Show Pic: https://cdn.freshair.radio/upload/${data.show_pic} 
      Show Demo: https://cdn.freshair.radio/upload/${data.show_demo}`
    })
    .then(msg => console.log(msg)) // logs response data
    .catch(err => console.log(err)); // logs any error

    

    return res.sendStatus(200);
  } catch (e) {
    console.log(e);
    return res.status(500).send(e);
  }
});

app.listen(port, () => console.log(`forms.api listening on port ${port}!`));
