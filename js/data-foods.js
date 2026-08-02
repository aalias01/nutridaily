/* NutriDaily — curated food database.
 * per100 = per 100 g edible portion: kcal, p(rotein), c(arbs), f(at), fb(fiber) g, na(sodium) mg.
 * units = food-specific gram weights for household measures.
 * cat = category, used for plausibility checks.
 *
 * Source: USDA FoodData Central style averages (standard reference / survey),
 * rounded for diary use. Good for everyday logging; not lab-certified for a
 * specific brand or cooking method. Users can Edit food to override any entry.
 */
const FOOD_DB = [
  // ---- Poultry / meat (cooked unless noted) ----
  { id: "chicken-breast", name: "chicken breast (cooked)", aliases: ["chicken breast", "grilled chicken", "chicken"], per100: { kcal: 165, p: 31, c: 0, f: 3.6, fb: 0, na: 74 }, units: { piece: 120 }, cat: "meat" },
  { id: "chicken-thigh", name: "chicken thigh (cooked)", aliases: ["chicken thigh", "chicken thighs"], per100: { kcal: 209, p: 26, c: 0, f: 10.9, fb: 0, na: 84 }, units: { piece: 85 }, cat: "meat" },
  { id: "ground-beef", name: "ground beef 85% (cooked)", aliases: ["ground beef", "minced beef", "beef mince"], per100: { kcal: 218, p: 26, c: 0, f: 13, fb: 0, na: 72 }, units: {}, cat: "meat" },
  { id: "steak", name: "steak, sirloin (cooked)", aliases: ["steak", "sirloin", "beef steak"], per100: { kcal: 206, p: 29, c: 0, f: 9.6, fb: 0, na: 56 }, units: { piece: 200 }, cat: "meat" },
  { id: "pork-chop", name: "pork chop (cooked)", aliases: ["pork chop", "pork"], per100: { kcal: 197, p: 27, c: 0, f: 9, fb: 0, na: 60 }, units: { piece: 145 }, cat: "meat" },
  { id: "bacon", name: "bacon (cooked)", aliases: ["bacon"], per100: { kcal: 541, p: 37, c: 1.4, f: 42, fb: 0, na: 1717 }, units: { slice: 12, piece: 12 }, cat: "meat" },
  { id: "turkey-breast", name: "turkey breast (cooked)", aliases: ["turkey", "turkey breast", "deli turkey"], per100: { kcal: 147, p: 30, c: 0, f: 2.1, fb: 0, na: 99 }, units: { slice: 28 }, cat: "meat" },
  { id: "lamb", name: "lamb (cooked)", aliases: ["lamb", "mutton"], per100: { kcal: 258, p: 25.6, c: 0, f: 16.5, fb: 0, na: 66 }, units: {}, cat: "meat" },

  // ---- Fish / seafood ----
  { id: "salmon", name: "salmon (cooked)", aliases: ["salmon", "grilled salmon"], per100: { kcal: 206, p: 22, c: 0, f: 12.4, fb: 0, na: 61 }, units: { fillet: 150, piece: 150 }, cat: "meat" },
  { id: "tuna-canned", name: "tuna, canned in water", aliases: ["tuna", "canned tuna"], per100: { kcal: 116, p: 25.5, c: 0, f: 0.8, fb: 0, na: 338 }, units: { can: 142 }, cat: "meat" },
  { id: "shrimp", name: "shrimp (cooked)", aliases: ["shrimp", "prawns"], per100: { kcal: 99, p: 24, c: 0.2, f: 0.3, fb: 0, na: 111 }, units: { piece: 8 }, cat: "meat" },
  { id: "tilapia", name: "tilapia (cooked)", aliases: ["tilapia", "white fish"], per100: { kcal: 128, p: 26, c: 0, f: 2.7, fb: 0, na: 56 }, units: { fillet: 115, piece: 115 }, cat: "meat" },
  { id: "cod", name: "cod (cooked)", aliases: ["cod"], per100: { kcal: 105, p: 22.8, c: 0, f: 0.9, fb: 0, na: 78 }, units: { fillet: 120, piece: 120 }, cat: "meat" },

  // ---- Eggs / dairy / soy protein ----
  { id: "egg", name: "egg, whole", aliases: ["egg", "eggs", "boiled egg", "fried egg", "scrambled eggs"], per100: { kcal: 148, p: 12.5, c: 1, f: 10, fb: 0, na: 142 }, units: { piece: 50, large: 50 }, cat: "protein" },
  { id: "egg-white", name: "egg white", aliases: ["egg white", "egg whites"], per100: { kcal: 52, p: 10.9, c: 0.7, f: 0.2, fb: 0, na: 166 }, units: { piece: 33 }, cat: "protein" },
  { id: "greek-yogurt-nonfat", name: "greek yogurt, nonfat", aliases: ["greek yogurt", "nonfat greek yogurt", "fage", "skyr"], per100: { kcal: 59, p: 10.2, c: 3.6, f: 0.4, fb: 0, na: 36 }, units: { cup: 245, container: 170, bowl: 245 }, cat: "dairy" },
  { id: "greek-yogurt-whole", name: "greek yogurt, whole milk", aliases: ["whole greek yogurt", "full fat greek yogurt"], per100: { kcal: 97, p: 9, c: 3.9, f: 5, fb: 0, na: 35 }, units: { cup: 245, container: 170, bowl: 245 }, cat: "dairy" },
  { id: "yogurt-plain", name: "yogurt, plain (dahi)", aliases: ["yogurt", "curd", "dahi", "plain yogurt"], per100: { kcal: 61, p: 3.5, c: 4.7, f: 3.3, fb: 0, na: 46 }, units: { cup: 245, bowl: 200 }, cat: "dairy" },
  { id: "cottage-cheese", name: "cottage cheese, 2%", aliases: ["cottage cheese"], per100: { kcal: 84, p: 11, c: 4.3, f: 2.3, fb: 0, na: 330 }, units: { cup: 226 }, cat: "dairy" },
  { id: "paneer", name: "paneer", aliases: ["paneer"], per100: { kcal: 296, p: 18, c: 3.6, f: 23, fb: 0, na: 18 }, units: { cube: 12 }, cat: "dairy" },
  { id: "tofu", name: "tofu, firm", aliases: ["tofu"], per100: { kcal: 78, p: 9.4, c: 1.9, f: 4.2, fb: 0.9, na: 12 }, units: { block: 350 }, cat: "protein" },
  { id: "tempeh", name: "tempeh", aliases: ["tempeh"], per100: { kcal: 195, p: 20, c: 9, f: 11, fb: 6.5, na: 14 }, units: {}, cat: "protein" },
  { id: "whey-protein", name: "whey protein powder", aliases: ["whey", "protein powder", "protein shake", "whey protein"], per100: { kcal: 387, p: 77, c: 10, f: 5, fb: 1, na: 160 }, units: { scoop: 31 }, cat: "protein" },

  // ---- Grains / breads ----
  { id: "white-rice", name: "white rice (cooked)", aliases: ["white rice", "rice", "jasmine rice", "steamed rice"], per100: { kcal: 130, p: 2.7, c: 28.2, f: 0.3, fb: 0.4, na: 1 }, units: { cup: 158, bowl: 200 }, cat: "grain" },
  { id: "brown-rice", name: "brown rice (cooked)", aliases: ["brown rice"], per100: { kcal: 123, p: 2.7, c: 25.6, f: 1, fb: 1.6, na: 4 }, units: { cup: 195, bowl: 200 }, cat: "grain" },
  { id: "basmati-rice", name: "basmati rice (cooked)", aliases: ["basmati", "basmati rice"], per100: { kcal: 121, p: 3, c: 25, f: 0.4, fb: 0.6, na: 2 }, units: { cup: 163, bowl: 200 }, cat: "grain" },
  { id: "quinoa", name: "quinoa (cooked)", aliases: ["quinoa"], per100: { kcal: 120, p: 4.4, c: 21.3, f: 1.9, fb: 2.8, na: 7 }, units: { cup: 185, bowl: 200 }, cat: "grain" },
  { id: "oats-dry", name: "oats, rolled (dry)", aliases: ["oats", "rolled oats", "dry oats"], per100: { kcal: 379, p: 13.2, c: 67.7, f: 6.5, fb: 10.1, na: 6 }, units: { cup: 81 }, cat: "grain" },
  { id: "oatmeal", name: "oatmeal (cooked with water)", aliases: ["oatmeal", "porridge"], per100: { kcal: 71, p: 2.5, c: 12, f: 1.5, fb: 1.7, na: 4 }, units: { cup: 234, bowl: 240 }, cat: "grain" },
  { id: "pasta", name: "pasta (cooked)", aliases: ["pasta", "spaghetti", "penne", "noodles"], per100: { kcal: 158, p: 5.8, c: 30.9, f: 0.9, fb: 1.8, na: 1 }, units: { cup: 140, bowl: 200 }, cat: "grain" },
  { id: "bread-white", name: "bread, white", aliases: ["white bread", "bread", "toast"], per100: { kcal: 265, p: 9, c: 49, f: 3.2, fb: 2.7, na: 491 }, units: { slice: 28, piece: 28 }, cat: "grain" },
  { id: "bread-ww", name: "bread, whole wheat", aliases: ["whole wheat bread", "wheat bread", "brown bread", "whole wheat toast"], per100: { kcal: 252, p: 12.3, c: 42.7, f: 3.5, fb: 6.8, na: 400 }, units: { slice: 32, piece: 32 }, cat: "grain" },
  { id: "chapati", name: "chapati / roti", aliases: ["chapati", "chapatis", "roti", "rotis", "costco chapati", "costco chapatis", "chapathi", "phulka"], per100: { kcal: 297, p: 9.6, c: 50, f: 7.2, fb: 4.9, na: 409 }, units: { piece: 60 }, cat: "grain" },
  { id: "naan", name: "naan", aliases: ["naan", "butter naan"], per100: { kcal: 310, p: 9, c: 50, f: 8, fb: 2.2, na: 465 }, units: { piece: 90 }, cat: "grain" },
  { id: "paratha", name: "paratha", aliases: ["paratha", "aloo paratha"], per100: { kcal: 330, p: 6.4, c: 43, f: 14.5, fb: 4.5, na: 530 }, units: { piece: 80 }, cat: "grain" },
  { id: "tortilla-flour", name: "tortilla, flour", aliases: ["flour tortilla", "tortilla", "wrap"], per100: { kcal: 306, p: 8.2, c: 50, f: 7.7, fb: 3.3, na: 736 }, units: { piece: 45 }, cat: "grain" },
  { id: "tortilla-corn", name: "tortilla, corn", aliases: ["corn tortilla"], per100: { kcal: 218, p: 5.7, c: 44.6, f: 2.9, fb: 6.3, na: 45 }, units: { piece: 26 }, cat: "grain" },
  { id: "bagel", name: "bagel", aliases: ["bagel"], per100: { kcal: 257, p: 10, c: 50, f: 1.7, fb: 2.1, na: 430 }, units: { piece: 105 }, cat: "grain" },
  { id: "dosa", name: "dosa", aliases: ["dosa", "masala dosa"], per100: { kcal: 168, p: 3.9, c: 29, f: 3.7, fb: 1.4, na: 300 }, units: { piece: 85 }, cat: "grain" },
  { id: "idli", name: "idli", aliases: ["idli", "idlis"], per100: { kcal: 130, p: 4.3, c: 27.6, f: 0.4, fb: 1.5, na: 205 }, units: { piece: 40 }, cat: "grain" },
  { id: "upma", name: "upma", aliases: ["upma"], per100: { kcal: 155, p: 3.5, c: 22, f: 6, fb: 1.8, na: 350 }, units: { bowl: 200, cup: 165 }, cat: "grain" },
  { id: "poha", name: "poha", aliases: ["poha"], per100: { kcal: 158, p: 3, c: 27, f: 4.5, fb: 1.5, na: 320 }, units: { bowl: 200, cup: 160 }, cat: "grain" },
  { id: "cereal", name: "breakfast cereal", aliases: ["cereal", "corn flakes", "cheerios"], per100: { kcal: 379, p: 7, c: 84, f: 1.5, fb: 3.5, na: 500 }, units: { cup: 30, bowl: 40 }, cat: "grain" },
  { id: "granola", name: "granola", aliases: ["granola", "muesli"], per100: { kcal: 471, p: 10, c: 64, f: 20, fb: 7, na: 20 }, units: { cup: 100, serving: 50 }, cat: "grain" },

  // ---- Legumes / Indian mains ----
  { id: "dal", name: "dal (cooked, tempered)", aliases: ["dal", "daal", "dhal", "lentil curry", "dal tadka", "dal fry", "sambar"], per100: { kcal: 130, p: 7, c: 18, f: 3, fb: 6, na: 350 }, units: { cup: 198, bowl: 240, katori: 150 }, cat: "legume" },
  { id: "lentils", name: "lentils, plain (cooked)", aliases: ["lentils", "cooked lentils", "masoor"], per100: { kcal: 116, p: 9, c: 20.1, f: 0.4, fb: 7.9, na: 2 }, units: { cup: 198, bowl: 240 }, cat: "legume" },
  { id: "chickpeas", name: "chickpeas (cooked)", aliases: ["chickpeas", "garbanzo", "chana"], per100: { kcal: 164, p: 8.9, c: 27.4, f: 2.6, fb: 7.6, na: 7 }, units: { cup: 164, can: 240 }, cat: "legume" },
  { id: "chana-masala", name: "chana masala", aliases: ["chana masala", "chole", "chickpea curry"], per100: { kcal: 150, p: 7, c: 20, f: 5, fb: 6, na: 400 }, units: { bowl: 240, cup: 200, katori: 150 }, cat: "legume" },
  { id: "black-beans", name: "black beans (cooked)", aliases: ["black beans"], per100: { kcal: 132, p: 8.9, c: 23.7, f: 0.5, fb: 8.7, na: 1 }, units: { cup: 172, can: 240 }, cat: "legume" },
  { id: "kidney-beans", name: "kidney beans (cooked)", aliases: ["kidney beans", "rajma beans"], per100: { kcal: 127, p: 8.7, c: 22.8, f: 0.5, fb: 6.4, na: 1 }, units: { cup: 177 }, cat: "legume" },
  { id: "rajma", name: "rajma curry", aliases: ["rajma", "rajma masala", "kidney bean curry"], per100: { kcal: 120, p: 6, c: 15, f: 4, fb: 5, na: 380 }, units: { bowl: 240, cup: 200, katori: 150 }, cat: "legume" },
  { id: "edamame", name: "edamame (shelled)", aliases: ["edamame"], per100: { kcal: 121, p: 11.9, c: 8.9, f: 5.2, fb: 5.2, na: 6 }, units: { cup: 155 }, cat: "legume" },
  { id: "hummus", name: "hummus", aliases: ["hummus"], per100: { kcal: 166, p: 7.9, c: 14.3, f: 9.6, fb: 6, na: 379 }, units: { tbsp: 15 }, cat: "legume" },

  // ---- Indian curries / prepared dishes ----
  { id: "palak-paneer", name: "palak paneer", aliases: ["palak paneer", "saag paneer"], per100: { kcal: 180, p: 8, c: 6, f: 14, fb: 2.5, na: 420 }, units: { bowl: 240, cup: 200, katori: 150 }, cat: "dish" },
  { id: "butter-chicken", name: "butter chicken", aliases: ["butter chicken", "chicken makhani"], per100: { kcal: 200, p: 14, c: 6, f: 13, fb: 1, na: 450 }, units: { bowl: 240, cup: 200 }, cat: "dish" },
  { id: "chicken-curry", name: "chicken curry (homestyle)", aliases: ["chicken curry", "curry chicken"], per100: { kcal: 145, p: 14, c: 5, f: 8, fb: 1.2, na: 400 }, units: { bowl: 240, cup: 200, katori: 150 }, cat: "dish" },
  { id: "veg-curry", name: "vegetable curry", aliases: ["vegetable curry", "veg curry", "mixed veg curry", "sabzi", "sabji"], per100: { kcal: 95, p: 2.5, c: 9, f: 5.5, fb: 2.5, na: 380 }, units: { bowl: 240, cup: 200, katori: 150 }, cat: "dish" },
  { id: "aloo-gobi", name: "aloo gobi", aliases: ["aloo gobi"], per100: { kcal: 90, p: 2, c: 11, f: 4.5, fb: 2.5, na: 350 }, units: { bowl: 240, cup: 200 }, cat: "dish" },
  { id: "bhindi", name: "bhindi sabzi (okra)", aliases: ["bhindi", "okra", "bhindi masala"], per100: { kcal: 80, p: 2, c: 8, f: 5, fb: 3.5, na: 330 }, units: { bowl: 200, cup: 160 }, cat: "dish" },
  { id: "biryani-chicken", name: "chicken biryani", aliases: ["biryani", "chicken biryani"], per100: { kcal: 165, p: 8.5, c: 20, f: 5.5, fb: 1, na: 420 }, units: { bowl: 250, cup: 200, plate: 350 }, cat: "dish" },

  // ---- Vegetables ----
  { id: "stir-fry-veg", name: "stir-fried vegetables (with oil)", aliases: ["stir-fried vegetables", "stir fried vegetables", "stir fry vegetables", "stir fry veggies", "sauteed vegetables"], per100: { kcal: 80, p: 2.5, c: 8, f: 4.5, fb: 3, na: 250 }, units: { cup: 130, bowl: 180 }, cat: "veg" },
  { id: "broccoli", name: "broccoli (cooked)", aliases: ["broccoli"], per100: { kcal: 35, p: 2.4, c: 7.2, f: 0.4, fb: 3.3, na: 41 }, units: { cup: 156 }, cat: "veg" },
  { id: "spinach", name: "spinach (cooked)", aliases: ["spinach", "palak"], per100: { kcal: 23, p: 3, c: 3.8, f: 0.3, fb: 2.4, na: 70 }, units: { cup: 180 }, cat: "veg" },
  { id: "salad-greens", name: "salad greens (raw)", aliases: ["salad", "lettuce", "mixed greens", "green salad"], per100: { kcal: 20, p: 2, c: 3.5, f: 0.3, fb: 2, na: 25 }, units: { cup: 36, bowl: 85 }, cat: "veg" },
  { id: "carrot", name: "carrot", aliases: ["carrot", "carrots"], per100: { kcal: 41, p: 0.9, c: 9.6, f: 0.2, fb: 2.8, na: 69 }, units: { piece: 61, cup: 128 }, cat: "veg" },
  { id: "bell-pepper", name: "bell pepper", aliases: ["bell pepper", "capsicum", "peppers"], per100: { kcal: 26, p: 1, c: 6, f: 0.3, fb: 2.1, na: 4 }, units: { piece: 119, cup: 92 }, cat: "veg" },
  { id: "cauliflower", name: "cauliflower (cooked)", aliases: ["cauliflower", "gobi"], per100: { kcal: 25, p: 1.9, c: 5, f: 0.3, fb: 2, na: 15 }, units: { cup: 124 }, cat: "veg" },
  { id: "green-beans", name: "green beans (cooked)", aliases: ["green beans", "string beans"], per100: { kcal: 35, p: 1.9, c: 7.9, f: 0.2, fb: 3.2, na: 1 }, units: { cup: 125 }, cat: "veg" },
  { id: "sweet-potato", name: "sweet potato (cooked)", aliases: ["sweet potato", "yam"], per100: { kcal: 90, p: 2, c: 20.7, f: 0.2, fb: 3.3, na: 36 }, units: { piece: 150, medium: 150 }, cat: "veg" },
  { id: "potato", name: "potato (cooked)", aliases: ["potato", "boiled potato", "baked potato", "aloo"], per100: { kcal: 87, p: 1.9, c: 20.1, f: 0.1, fb: 1.8, na: 6 }, units: { piece: 170, medium: 170 }, cat: "veg" },
  { id: "onion", name: "onion", aliases: ["onion", "onions"], per100: { kcal: 40, p: 1.1, c: 9.3, f: 0.1, fb: 1.7, na: 4 }, units: { piece: 110, medium: 110 }, cat: "veg" },
  { id: "tomato", name: "tomato", aliases: ["tomato", "tomatoes"], per100: { kcal: 18, p: 0.9, c: 3.9, f: 0.2, fb: 1.2, na: 5 }, units: { piece: 123, medium: 123 }, cat: "veg" },
  { id: "cucumber", name: "cucumber", aliases: ["cucumber"], per100: { kcal: 15, p: 0.7, c: 3.6, f: 0.1, fb: 0.5, na: 2 }, units: { piece: 200, cup: 119 }, cat: "veg" },
  { id: "corn", name: "corn, sweet (cooked)", aliases: ["corn", "sweet corn"], per100: { kcal: 96, p: 3.4, c: 21, f: 1.5, fb: 2.4, na: 1 }, units: { ear: 90, cup: 145 }, cat: "veg" },
  { id: "mushroom", name: "mushrooms (cooked)", aliases: ["mushroom", "mushrooms"], per100: { kcal: 28, p: 2.2, c: 5.3, f: 0.5, fb: 2.2, na: 2 }, units: { cup: 108 }, cat: "veg" },
  { id: "zucchini", name: "zucchini (cooked)", aliases: ["zucchini", "courgette"], per100: { kcal: 17, p: 1.2, c: 3.1, f: 0.3, fb: 1, na: 3 }, units: { cup: 180, piece: 196 }, cat: "veg" },
  { id: "avocado", name: "avocado", aliases: ["avocado", "avo"], per100: { kcal: 160, p: 2, c: 8.5, f: 14.7, fb: 6.7, na: 7 }, units: { piece: 150, half: 75, medium: 150 }, cat: "veg" },

  // ---- Fruits ----
  { id: "banana", name: "banana", aliases: ["banana", "bananas"], per100: { kcal: 89, p: 1.1, c: 22.8, f: 0.3, fb: 2.6, na: 1 }, units: { piece: 118, medium: 118, large: 136, small: 101 }, cat: "fruit" },
  { id: "apple", name: "apple", aliases: ["apple", "apples"], per100: { kcal: 52, p: 0.3, c: 13.8, f: 0.2, fb: 2.4, na: 1 }, units: { piece: 182, medium: 182 }, cat: "fruit" },
  { id: "orange", name: "orange", aliases: ["orange", "oranges"], per100: { kcal: 47, p: 0.9, c: 11.8, f: 0.1, fb: 2.4, na: 0 }, units: { piece: 131, medium: 131 }, cat: "fruit" },
  { id: "mango", name: "mango", aliases: ["mango", "mangoes"], per100: { kcal: 60, p: 0.8, c: 15, f: 0.4, fb: 1.6, na: 1 }, units: { piece: 200, cup: 165 }, cat: "fruit" },
  { id: "grapes", name: "grapes", aliases: ["grapes"], per100: { kcal: 69, p: 0.7, c: 18.1, f: 0.2, fb: 0.9, na: 2 }, units: { cup: 151 }, cat: "fruit" },
  { id: "strawberries", name: "strawberries", aliases: ["strawberry", "strawberries"], per100: { kcal: 32, p: 0.7, c: 7.7, f: 0.3, fb: 2, na: 1 }, units: { cup: 152, piece: 12 }, cat: "fruit" },
  { id: "blueberries", name: "blueberries", aliases: ["blueberry", "blueberries"], per100: { kcal: 57, p: 0.7, c: 14.5, f: 0.3, fb: 2.4, na: 1 }, units: { cup: 148 }, cat: "fruit" },
  { id: "watermelon", name: "watermelon", aliases: ["watermelon"], per100: { kcal: 30, p: 0.6, c: 7.6, f: 0.2, fb: 0.4, na: 1 }, units: { cup: 152, slice: 286 }, cat: "fruit" },
  { id: "pineapple", name: "pineapple", aliases: ["pineapple"], per100: { kcal: 50, p: 0.5, c: 13.1, f: 0.1, fb: 1.4, na: 1 }, units: { cup: 165 }, cat: "fruit" },
  { id: "dates", name: "dates (medjool)", aliases: ["date", "dates", "medjool dates"], per100: { kcal: 277, p: 1.8, c: 75, f: 0.2, fb: 6.7, na: 1 }, units: { piece: 24 }, cat: "fruit" },
  { id: "raisins", name: "raisins", aliases: ["raisins"], per100: { kcal: 299, p: 3.1, c: 79.2, f: 0.5, fb: 3.7, na: 11 }, units: { tbsp: 9, cup: 145 }, cat: "fruit" },
  { id: "pomegranate", name: "pomegranate arils", aliases: ["pomegranate", "anar"], per100: { kcal: 83, p: 1.7, c: 18.7, f: 1.2, fb: 4, na: 3 }, units: { cup: 174 }, cat: "fruit" },

  // ---- Dairy / fats / nuts ----
  { id: "milk-whole", name: "milk, whole", aliases: ["whole milk", "milk"], per100: { kcal: 61, p: 3.2, c: 4.8, f: 3.3, fb: 0, na: 43 }, units: { cup: 244, glass: 244 }, cat: "dairy" },
  { id: "milk-2", name: "milk, 2%", aliases: ["2% milk", "reduced fat milk"], per100: { kcal: 50, p: 3.3, c: 4.8, f: 2, fb: 0, na: 47 }, units: { cup: 244, glass: 244 }, cat: "dairy" },
  { id: "milk-skim", name: "milk, skim", aliases: ["skim milk", "nonfat milk"], per100: { kcal: 34, p: 3.4, c: 5, f: 0.1, fb: 0, na: 42 }, units: { cup: 245, glass: 245 }, cat: "dairy" },
  { id: "almond-milk", name: "almond milk, unsweetened", aliases: ["almond milk"], per100: { kcal: 13, p: 0.4, c: 0.3, f: 1.1, fb: 0.2, na: 72 }, units: { cup: 240, glass: 240 }, cat: "dairy" },
  { id: "cheddar", name: "cheddar cheese", aliases: ["cheddar", "cheese"], per100: { kcal: 403, p: 24.9, c: 1.3, f: 33.1, fb: 0, na: 653 }, units: { slice: 21, cup: 113 }, cat: "dairy" },
  { id: "mozzarella", name: "mozzarella", aliases: ["mozzarella"], per100: { kcal: 300, p: 22, c: 2.2, f: 22.4, fb: 0, na: 627 }, units: { slice: 21, cup: 112 }, cat: "dairy" },
  { id: "butter", name: "butter", aliases: ["butter"], per100: { kcal: 717, p: 0.9, c: 0.1, f: 81.1, fb: 0, na: 643 }, units: { tbsp: 14, tsp: 5, pat: 5 }, cat: "fat" },
  { id: "ghee", name: "ghee", aliases: ["ghee", "clarified butter"], per100: { kcal: 900, p: 0, c: 0, f: 100, fb: 0, na: 0 }, units: { tbsp: 13, tsp: 4.3 }, cat: "fat" },
  { id: "olive-oil", name: "olive oil", aliases: ["olive oil", "oil", "cooking oil"], per100: { kcal: 884, p: 0, c: 0, f: 100, fb: 0, na: 2 }, units: { tbsp: 13.5, tsp: 4.5 }, cat: "fat" },
  { id: "mayo", name: "mayonnaise", aliases: ["mayo", "mayonnaise"], per100: { kcal: 680, p: 1, c: 0.6, f: 75, fb: 0, na: 635 }, units: { tbsp: 14 }, cat: "fat" },
  { id: "peanut-butter", name: "peanut butter", aliases: ["peanut butter", "pb"], per100: { kcal: 588, p: 25.1, c: 19.6, f: 50, fb: 6, na: 426 }, units: { tbsp: 16, tsp: 5.3 }, cat: "nuts" },
  { id: "almond-butter", name: "almond butter", aliases: ["almond butter"], per100: { kcal: 614, p: 21, c: 18.8, f: 55.5, fb: 10.3, na: 2 }, units: { tbsp: 16 }, cat: "nuts" },
  { id: "almonds", name: "almonds", aliases: ["almond", "almonds"], per100: { kcal: 579, p: 21.2, c: 21.6, f: 49.9, fb: 12.5, na: 1 }, units: { handful: 28, piece: 1.2, cup: 143 }, cat: "nuts" },
  { id: "walnuts", name: "walnuts", aliases: ["walnut", "walnuts"], per100: { kcal: 654, p: 15.2, c: 13.7, f: 65.2, fb: 6.7, na: 2 }, units: { handful: 28, piece: 4, cup: 117 }, cat: "nuts" },
  { id: "cashews", name: "cashews", aliases: ["cashew", "cashews"], per100: { kcal: 553, p: 18.2, c: 30.2, f: 43.9, fb: 3.3, na: 12 }, units: { handful: 28, piece: 1.6, cup: 137 }, cat: "nuts" },
  { id: "peanuts", name: "peanuts", aliases: ["peanut", "peanuts"], per100: { kcal: 567, p: 25.8, c: 16.1, f: 49.2, fb: 8.5, na: 18 }, units: { handful: 28, cup: 146 }, cat: "nuts" },
  { id: "mixed-nuts", name: "mixed nuts", aliases: ["mixed nuts", "trail mix nuts"], per100: { kcal: 607, p: 20, c: 21, f: 54, fb: 7, na: 12 }, units: { handful: 28, cup: 137 }, cat: "nuts" },
  { id: "chia", name: "chia seeds", aliases: ["chia", "chia seeds"], per100: { kcal: 486, p: 16.5, c: 42.1, f: 30.7, fb: 34.4, na: 16 }, units: { tbsp: 12 }, cat: "nuts" },
  { id: "flax", name: "flax seeds (ground)", aliases: ["flax", "flaxseed", "flax seeds"], per100: { kcal: 534, p: 18.3, c: 28.9, f: 42.2, fb: 27.3, na: 30 }, units: { tbsp: 7 }, cat: "nuts" },

  // ---- Beverages ----
  { id: "coffee-black", name: "coffee, black", aliases: ["black coffee", "coffee", "americano", "espresso"], per100: { kcal: 2, p: 0.3, c: 0, f: 0, fb: 0, na: 2 }, units: { cup: 240, shot: 30 }, cat: "bev" },
  { id: "coffee-milk", name: "coffee with milk", aliases: ["coffee with milk", "milk coffee", "white coffee"], per100: { kcal: 18, p: 1, c: 1.4, f: 1, fb: 0, na: 12 }, units: { cup: 250 }, cat: "bev" },
  { id: "latte", name: "latte (whole milk)", aliases: ["latte", "cappuccino", "flat white"], per100: { kcal: 44, p: 2.3, c: 3.6, f: 2.4, fb: 0, na: 30 }, units: { cup: 240, small: 240, medium: 350, large: 470 }, cat: "bev" },
  { id: "chai", name: "chai (milk tea with sugar)", aliases: ["chai", "milk tea", "tea with milk"], per100: { kcal: 55, p: 1.5, c: 8, f: 2, fb: 0, na: 10 }, units: { cup: 200, glass: 250 }, cat: "bev" },
  { id: "green-tea", name: "green tea / black tea (plain)", aliases: ["green tea", "tea", "black tea"], per100: { kcal: 1, p: 0, c: 0.2, f: 0, fb: 0, na: 1 }, units: { cup: 240 }, cat: "bev" },
  { id: "orange-juice", name: "orange juice", aliases: ["orange juice", "oj"], per100: { kcal: 45, p: 0.7, c: 10.4, f: 0.2, fb: 0.2, na: 1 }, units: { cup: 248, glass: 248 }, cat: "bev" },
  { id: "soda", name: "soda (cola)", aliases: ["soda", "cola", "coke", "pepsi"], per100: { kcal: 41, p: 0, c: 10.6, f: 0, fb: 0, na: 4 }, units: { can: 355, bottle: 500, glass: 300 }, cat: "bev" },
  { id: "diet-soda", name: "diet soda", aliases: ["diet soda", "diet coke", "coke zero"], per100: { kcal: 0, p: 0, c: 0, f: 0, fb: 0, na: 12 }, units: { can: 355, bottle: 500 }, cat: "bev" },
  { id: "beer", name: "beer", aliases: ["beer", "lager"], per100: { kcal: 43, p: 0.5, c: 3.6, f: 0, fb: 0, na: 4 }, units: { can: 355, bottle: 355, pint: 473 }, cat: "bev" },
  { id: "wine", name: "wine", aliases: ["wine", "red wine", "white wine"], per100: { kcal: 83, p: 0.1, c: 2.6, f: 0, fb: 0, na: 4 }, units: { glass: 148 }, cat: "bev" },
  { id: "smoothie", name: "fruit smoothie", aliases: ["smoothie", "fruit smoothie"], per100: { kcal: 60, p: 1.2, c: 13, f: 0.5, fb: 1.2, na: 15 }, units: { cup: 245, glass: 350, bottle: 450 }, cat: "bev" },
  { id: "lassi", name: "lassi (sweet)", aliases: ["lassi", "sweet lassi", "mango lassi"], per100: { kcal: 75, p: 2.5, c: 12, f: 2, fb: 0.1, na: 25 }, units: { glass: 250, cup: 240 }, cat: "bev" },

  // ---- Snacks / prepared / restaurant ----
  { id: "protein-bar", name: "protein bar", aliases: ["protein bar", "quest bar", "rx bar"], per100: { kcal: 375, p: 33, c: 40, f: 12, fb: 10, na: 350 }, units: { bar: 60, piece: 60 }, cat: "snack" },
  { id: "granola-bar", name: "granola bar", aliases: ["granola bar", "cereal bar"], per100: { kcal: 471, p: 8, c: 64, f: 20, fb: 5, na: 250 }, units: { bar: 35, piece: 35 }, cat: "snack" },
  { id: "dark-chocolate", name: "dark chocolate (70%)", aliases: ["dark chocolate", "chocolate"], per100: { kcal: 546, p: 4.9, c: 61, f: 31, fb: 7, na: 24 }, units: { square: 10, bar: 100, piece: 10 }, cat: "snack" },
  { id: "chips", name: "potato chips", aliases: ["chips", "potato chips", "crisps", "lays"], per100: { kcal: 536, p: 7, c: 53, f: 35, fb: 4.4, na: 525 }, units: { serving: 28, bag: 45, handful: 20 }, cat: "snack" },
  { id: "popcorn", name: "popcorn, air-popped", aliases: ["popcorn"], per100: { kcal: 387, p: 12.9, c: 77.8, f: 4.5, fb: 14.5, na: 8 }, units: { cup: 8, bag: 60 }, cat: "snack" },
  { id: "cookie", name: "cookie", aliases: ["cookie", "cookies", "biscuit"], per100: { kcal: 488, p: 5, c: 64, f: 24, fb: 2, na: 360 }, units: { piece: 30, small: 15, large: 60 }, cat: "snack" },
  { id: "samosa", name: "samosa", aliases: ["samosa", "samosas"], per100: { kcal: 308, p: 5, c: 32, f: 17, fb: 2.5, na: 420 }, units: { piece: 100 }, cat: "snack" },
  { id: "ice-cream", name: "ice cream, vanilla", aliases: ["ice cream", "icecream"], per100: { kcal: 207, p: 3.5, c: 23.6, f: 11, fb: 0.7, na: 80 }, units: { scoop: 66, cup: 132, pint: 390 }, cat: "snack" },
  { id: "pizza", name: "pizza, cheese", aliases: ["pizza", "cheese pizza", "pizza slice"], per100: { kcal: 266, p: 11, c: 33, f: 10, fb: 2.3, na: 598 }, units: { slice: 107, piece: 107 }, cat: "dish" },
  { id: "cheeseburger", name: "cheeseburger (fast food)", aliases: ["cheeseburger", "burger", "hamburger"], per100: { kcal: 263, p: 15, c: 24, f: 13, fb: 1.5, na: 500 }, units: { piece: 150 }, cat: "dish" },
  { id: "fries", name: "french fries", aliases: ["fries", "french fries", "chips (uk)"], per100: { kcal: 312, p: 3.4, c: 41.4, f: 15, fb: 3.8, na: 210 }, units: { serving: 117, small: 71, medium: 117, large: 154 }, cat: "dish" },
  { id: "burrito", name: "burrito, chicken", aliases: ["burrito", "chicken burrito"], per100: { kcal: 163, p: 9, c: 20, f: 5.5, fb: 2, na: 380 }, units: { piece: 300 }, cat: "dish" },
  { id: "burrito-bowl", name: "burrito bowl (chicken)", aliases: ["burrito bowl", "chipotle bowl"], per100: { kcal: 130, p: 9, c: 14, f: 4.5, fb: 2.5, na: 320 }, units: { bowl: 500 }, cat: "dish" },
  { id: "sushi-roll", name: "sushi roll (california)", aliases: ["sushi", "california roll", "sushi roll"], per100: { kcal: 150, p: 6, c: 26, f: 3, fb: 1.5, na: 320 }, units: { roll: 190, piece: 24 }, cat: "dish" },
  { id: "sandwich-turkey", name: "turkey sandwich", aliases: ["turkey sandwich", "sandwich"], per100: { kcal: 190, p: 11, c: 24, f: 5.5, fb: 1.8, na: 480 }, units: { piece: 230, half: 115 }, cat: "dish" },
  { id: "fried-rice", name: "fried rice", aliases: ["fried rice", "chicken fried rice", "veg fried rice"], per100: { kcal: 163, p: 5, c: 24, f: 5, fb: 0.9, na: 396 }, units: { cup: 198, bowl: 250, plate: 350 }, cat: "dish" },
  { id: "pad-thai", name: "pad thai", aliases: ["pad thai"], per100: { kcal: 172, p: 7.5, c: 22, f: 6, fb: 1.2, na: 430 }, units: { plate: 400, bowl: 300 }, cat: "dish" },
  { id: "ramen", name: "ramen (restaurant)", aliases: ["ramen"], per100: { kcal: 90, p: 4.5, c: 12, f: 2.8, fb: 0.7, na: 400 }, units: { bowl: 550 }, cat: "dish" },
  { id: "soup-veg", name: "vegetable soup", aliases: ["soup", "vegetable soup"], per100: { kcal: 40, p: 1.5, c: 6.5, f: 1, fb: 1.4, na: 320 }, units: { bowl: 300, cup: 240 }, cat: "dish" },
];

/** Everyday items surfaced in the Add sheet without ChatGPT. Order = display order. */
const FOOD_COMMON_IDS = [
  "banana", "apple", "egg", "chicken-breast", "greek-yogurt-nonfat", "oats-dry",
  "brown-rice", "white-rice", "chapati", "bread-ww", "salmon", "avocado",
  "milk-whole", "almonds", "olive-oil", "broccoli",
];

if (typeof module !== "undefined") module.exports = FOOD_DB;
