/**
 * Simple test to verify the user_id implementation in todo app
 * Run this in the browser console at http://localhost:5173/
 */

console.log('=== Testing Todo App with user_id Implementation ===');

// Test 1: Check if localStorage has the correct structure
console.log('\n1. Checking localStorage data structure...');
const todos = JSON.parse(localStorage.getItem('todo_app_todos') || '[]');
const categories = JSON.parse(
  localStorage.getItem('todo_app_categories') || '[]'
);

console.log(`Found ${todos.length} todos in localStorage`);
console.log(`Found ${categories.length} categories in localStorage`);

// Test 2: Verify todos have user_id instead of user object
console.log('\n2. Verifying todos have user_id field...');
todos.forEach((todo, index) => {
  if (todo.user_id) {
    console.log(`✅ Todo ${index + 1}: has user_id = "${todo.user_id}"`);
  } else if (todo.user) {
    console.error(`❌ Todo ${index + 1}: still has user object:`, todo.user);
  } else {
    console.warn(`⚠️ Todo ${index + 1}: missing both user and user_id`);
  }
});

// Test 3: Verify categories have user_id instead of user object
console.log('\n3. Verifying categories have user_id field...');
categories.forEach((category, index) => {
  if (category.user_id) {
    console.log(
      `✅ Category ${index + 1} (${category.name}): has user_id = "${category.user_id}"`
    );
  } else if (category.user) {
    console.error(
      `❌ Category ${index + 1} (${category.name}): still has user object:`,
      category.user
    );
  } else {
    console.warn(
      `⚠️ Category ${index + 1} (${category.name}): missing both user and user_id`
    );
  }
});

// Test 4: Check if nested category objects in todos also have user_id
console.log('\n4. Verifying nested category objects in todos...');
todos.forEach((todo, index) => {
  if (todo.category) {
    if (todo.category.user_id) {
      console.log(
        `✅ Todo ${index + 1}'s category: has user_id = "${todo.category.user_id}"`
      );
    } else if (todo.category.user) {
      console.error(
        `❌ Todo ${index + 1}'s category: still has user object:`,
        todo.category.user
      );
    } else {
      console.warn(
        `⚠️ Todo ${index + 1}'s category: missing both user and user_id`
      );
    }
  }
});

console.log('\n=== Test Complete ===');
console.log('Summary:');
console.log(`- Todos tested: ${todos.length}`);
console.log(`- Categories tested: ${categories.length}`);
console.log('✅ All data should use user_id field instead of user object');
