FROM node:20-slim
RUN apt-get update && apt-get install -y python3 python3-pip python3-venv
WORKDIR /app
COPY requirements.txt ./
RUN pip3 install --break-system-packages -r requirements.txt
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]