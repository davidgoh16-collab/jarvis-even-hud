# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Production stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
# Custom nginx config to handle SPA routing if needed, though this app is simple
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
