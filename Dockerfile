FROM node:20
RUN apt-get update && apt-get install -y python3 python3-pip
WORKDIR /app
COPY requirements.txt .
RUN pip3 install -r requirements.txt --break-system-packages
COPY package*.json ./
RUN npm install
COPY . .
CMD ["node", "server.js"]
