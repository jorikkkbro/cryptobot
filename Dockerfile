FROM node:20-alpine

WORKDIR /app

# Копируем package files
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci

# Копируем исходники
COPY . .

# Компилируем TypeScript
RUN npx tsc

# Копируем public в dist
RUN cp -r public dist/

# Порт
EXPOSE 3000

# Запуск
CMD ["node", "dist/index.js"]