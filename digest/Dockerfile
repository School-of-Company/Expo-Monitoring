FROM node:22-slim
WORKDIR /app
# no dependencies: plain Node ESM
COPY --chown=node:node *.mjs ./digest/
USER node
CMD ["node", "digest/index.mjs", "serve"]
