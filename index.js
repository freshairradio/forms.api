const mongoose = require("mongoose");
const express = require("express");
const fetch = require("node-fetch");
const AWS = require("aws-sdk");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;
const md5 = require("md5");
const app = express();
app.use(cors());
const port = process.env.PORT || 8764;
const spacesEndpoint = new AWS.Endpoint("nyc3.digitaloceanspaces.com");
const GhostAdminAPI = require("@tryghost/admin-api");
const ghostToken = process.env.GHOST_TOKEN;
const Admin = new GhostAdminAPI({
  url: "https://content.freshair.org.uk",
  key: ghostToken,
  version: "v3"
});
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

app.get("/results/contract", async (req, res) => {
  try {
    let ret = await Form.find({ slug: "contract" }, ["slug", "user"]);
    return res.json(ret);
  } catch (e) {
    console.error(e);
    return res.sendStatus(500);
  }
});

app.get("/results/stand", async (req, res) => {
  candidates = await Form.find({ slug: "stand" }, [
    "slug",
    "createdAt",
    "user",
    "data",
    "path"
  ]);
  candidates = await Promise.all(
    candidates.map(async c => {
      let u = await Admin.users.read({ slug: c.user });
      return {
        ...c,
        user: {
          slug: u.slug,
          email: u.email,
          pic: u.profile_image
            ? u.profile_image.startsWith("http")
              ? u.profile_image
              : `https://cdn.freshair.dev/upload/${u.profile_image}`
            : "",
          name: u.name
        }
      };
    })
  );
  return res.json(ret);
});
app.get("/results/apply", async (req, res) => {
  try {
    let ret = await Promise.all(
      (
        await Form.find({ slug: "apply" }, [
          "slug",
          "createdAt",
          "user",
          "data",
          "path"
        ])
      )
        .map(f => {
          let data = {};
          [...f.path].forEach(k => (data[k] = f.data[k]));
          return {
            user: f.user,
            slug: f.slug,
            createdAt: f.createdAt,
            path: f.path,
            data
          };
        })
        .map(async f => {
          if (Array.isArray(f.data.show_slug)) {
            f.data.show_slug = f.data.show_slug[0];
          }
          if (f.data.show_slug) {
            try {
              let show = await Admin.posts.read({
                slug: f.data.show_slug
              });
              console.log(show);
              f.data.show = {
                slug: show.slug,
                name: show.title,
                hosts: show.authors.map(a => ({
                  email: a.email,
                  slug: a.slug,
                  pic: a.profile_image,
                  name: a.name
                })),
                description: show.excerpt,
                demo: "",
                pic: show.feature_image
              };
            } catch (e) {
              console.error(e);
            }
          } else if (f.data.show_details) {
            f.data.show = {
              name: f.data.show_details.name,
              hosts: await Promise.all(
                [...new Set([f.user, ...f.data.show_people])]
                  .filter(u => u)
                  .map(async s => {
                    try {
                      let u = await Admin.users.read({ slug: s });
                      return {
                        slug: u.slug,
                        email: u.email,
                        pic: u.profile_image
                          ? u.profile_image.startsWith("http")
                            ? u.profile_image
                            : `https://cdn.freshair.dev/upload/${u.profile_image}`
                          : "",
                        name: u.name
                      };
                    } catch (e) {
                      console.log(e);
                      return s;
                    }
                  })
              ),
              description: f.data.show_details.description,
              demo: `https://cdn.freshair.dev/upload/${f.data.show_demo}`,
              pic: `https://cdn.freshair.dev/upload/${f.data.show_pic}`
            };
          }
          return f;
        })
    );
    return res.json(ret);
  } catch (e) {
    return res.status(500).send(e);
  }
});
app.post("/submit/:slug", async (req, res) => {
  try {
    let { data, path } = req.body;
    let auth = req.headers["x-auth-token"];
    let slug = req.params.slug.replace(/[^a-zA-Z-]+/g, "-").toLowerCase();
    let verify = await fetch(
      process.env.AUTH_API || `http://localhost:8007/verify`,
      {
        method: "POST",
        headers: {
          "X-Auth-Token": auth
        }
      }
    ).then(r => r.json());
    if (!verify.ok) {
      console.log(verify);
      return res.status(401).send(verify);
    }
    await Form.create({
      user: verify.slug,
      slug,
      data,
      path
    });
    return res.sendStatus(200);
  } catch (e) {
    console.log(e);
    return res.status(500).send(e);
  }
});

app.listen(port, () => console.log(`forms.api listening on port ${port}!`));
